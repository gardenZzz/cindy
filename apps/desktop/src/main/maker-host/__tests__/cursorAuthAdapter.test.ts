import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';

import {
  createDesktopCursorAuthAdapter,
  extractCursorLoginUrlForTest,
  parseCursorStatusOutputForTest,
} from '../cursor-auth-adapter.js';

function hangingLoginChild(opts?: {
  /** kill 不 emit close */
  killIgnoresClose?: boolean;
}): { child: ChildProcess & EventEmitter; kill: ReturnType<typeof vi.fn> } {
  const child = new EventEmitter() as ChildProcess & EventEmitter;
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  (child as { stdout: EventEmitter; stderr: EventEmitter }).stdout = stdout;
  (child as { stdout: EventEmitter; stderr: EventEmitter }).stderr = stderr;
  (child as { pid: number }).pid = 4242;
  const kill = vi.fn(() => {
    if (!opts?.killIgnoresClose) {
      queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
    }
    return true;
  });
  (child as { kill: (signal?: string) => boolean }).kill = kill;
  return { child, kill };
}

describe('parseCursorStatusOutputForTest', () => {
  it('parses authenticated JSON without retaining tokens', () => {
    const state = parseCursorStatusOutputForTest(
      JSON.stringify({
        status: 'authenticated',
        isAuthenticated: true,
        hasAccessToken: true,
        hasRefreshToken: true,
        userInfo: { email: 'dev@example.com' },
      }),
    );
    expect(state).toEqual({
      authenticated: true,
      identity: 'dev@example.com',
      authSource: 'oauth',
    });
  });

  it('parses unauthenticated JSON as no_credentials', () => {
    const state = parseCursorStatusOutputForTest(
      JSON.stringify({
        status: 'unauthenticated',
        isAuthenticated: false,
        hasAccessToken: false,
        hasRefreshToken: false,
      }),
    );
    expect(state).toEqual({
      authenticated: false,
      errorReason: 'no_credentials',
    });
  });
});

describe('extractCursorLoginUrlForTest', () => {
  it('extracts https URL and strips trailing punctuation', () => {
    expect(
      extractCursorLoginUrlForTest(
        'Open a browser and navigate to this link: https://authenticator.cursor.sh/login?token=fake-token-not-real.',
      ),
    ).toBe('https://authenticator.cursor.sh/login?token=fake-token-not-real');
  });
});

describe('DesktopCursorAuthAdapter', () => {
  it('getState uses status --format json and maps identity', async () => {
    const runCommand = vi.fn(async () => ({
      stdout: JSON.stringify({
        isAuthenticated: true,
        status: 'authenticated',
        userInfo: { email: 'fake@example.test' },
      }),
      stderr: '',
      code: 0,
    }));
    const adapter = createDesktopCursorAuthAdapter({
      binaryPath: '/fake/cursor-agent',
      runCommand,
    });
    await expect(adapter.getState()).resolves.toEqual({
      authenticated: true,
      identity: 'fake@example.test',
      authSource: 'oauth',
    });
    expect(runCommand).toHaveBeenCalledWith(
      ['status', '--format', 'json'],
      expect.objectContaining({
        env: expect.objectContaining({ NO_OPEN_BROWSER: '1' }),
      }),
    );
  });

  it('getAuthEnv never returns credential material', async () => {
    const adapter = createDesktopCursorAuthAdapter({
      binaryPath: '/fake/cursor-agent',
      runCommand: async () => ({ stdout: '', stderr: '', code: 0 }),
    });
    await expect(adapter.getAuthEnv()).resolves.toEqual({});
  });

  it('triggerLogin sets NO_OPEN_BROWSER and surfaces login URL via onProgress', async () => {
    const progress: string[] = [];
    const { child } = hangingLoginChild();

    let statusCalls = 0;
    const adapter = createDesktopCursorAuthAdapter({
      binaryPath: '/fake/cursor-agent',
      spawnProcess: (args, options) => {
        expect(args).toEqual(['login']);
        expect(options.env.NO_OPEN_BROWSER).toBe('1');
        queueMicrotask(() => {
          child.stdout!.emit(
            'data',
            'Open a browser and navigate to this link: https://authenticator.cursor.sh/?code=fake-not-real\n',
          );
          queueMicrotask(() => child.emit('close', 0));
        });
        return child;
      },
      runCommand: async (args) => {
        if (args[0] === 'status') {
          statusCalls += 1;
          return {
            stdout: JSON.stringify({
              isAuthenticated: true,
              status: 'authenticated',
              userInfo: { email: 'after-login@example.test' },
            }),
            stderr: '',
            code: 0,
          };
        }
        return { stdout: '', stderr: '', code: 0 };
      },
    });

    const state = await adapter.triggerLogin({
      onProgress: (msg) => progress.push(msg),
    });
    expect(state.authenticated).toBe(true);
    expect(state.identity).toBe('after-login@example.test');
    expect(progress.some((p) => p.includes('https://authenticator.cursor.sh/?code=fake-not-real'))).toBe(
      true,
    );
    expect(statusCalls).toBeGreaterThanOrEqual(1);
  });

  it('logout invokes cursor-agent logout via injected runner (no real CLI)', async () => {
    const runCommand = vi.fn(async (args: string[]) => {
      expect(args).toEqual(['logout']);
      return { stdout: '', stderr: '', code: 0 };
    });
    const adapter = createDesktopCursorAuthAdapter({
      binaryPath: '/fake/cursor-agent',
      runCommand,
    });
    await adapter.logout();
    expect(runCommand).toHaveBeenCalledWith(
      ['logout'],
      expect.objectContaining({
        env: expect.objectContaining({ NO_OPEN_BROWSER: '1' }),
      }),
    );
  });

  it('cancelLogin kills the in-flight login child', async () => {
    const { child, kill } = hangingLoginChild();

    const adapter = createDesktopCursorAuthAdapter({
      binaryPath: '/fake/cursor-agent',
      spawnProcess: () => child,
      runCommand: async () => ({
        stdout: JSON.stringify({ isAuthenticated: false }),
        stderr: '',
        code: 0,
      }),
      killProcessTree: (_pid, proc, onSettled) => {
        proc.kill('SIGKILL');
        onSettled?.();
      },
    });

    const loginPromise = adapter.triggerLogin();
    // 让 spawn 挂上后再 cancel
    await Promise.resolve();
    adapter.cancelLogin();
    const state = await loginPromise;
    expect(kill).toHaveBeenCalled();
    expect(state.authenticated).toBe(false);
  });

  it('login timeout settles even when kill does not emit close', async () => {
    const { child } = hangingLoginChild({ killIgnoresClose: true });
    const killTree = vi.fn((_pid: number | undefined, _proc: ChildProcess, onSettled?: () => void) => {
      onSettled?.();
    });

    const adapter = createDesktopCursorAuthAdapter({
      binaryPath: '/fake/cursor-agent',
      spawnProcess: () => child,
      runCommand: async () => ({
        stdout: JSON.stringify({ isAuthenticated: false }),
        stderr: '',
        code: 0,
      }),
      loginTimeoutMs: 40,
      forceSettleMs: 10,
      killProcessTree: killTree,
    });

    const started = Date.now();
    const state = await adapter.triggerLogin();
    expect(state.authenticated).toBe(false);
    expect(killTree).toHaveBeenCalled();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('logout awaits login exit after cancel even when kill does not emit close', async () => {
    const { child } = hangingLoginChild({ killIgnoresClose: true });
    const order: string[] = [];
    const killTree = vi.fn((_pid: number | undefined, _proc: ChildProcess, onSettled?: () => void) => {
      order.push('kill');
      onSettled?.();
    });
    const runCommand = vi.fn(async (args: string[]) => {
      if (args[0] === 'logout') {
        order.push('logout');
        return { stdout: '', stderr: '', code: 0 };
      }
      return {
        stdout: JSON.stringify({ isAuthenticated: false }),
        stderr: '',
        code: 0,
      };
    });

    const adapter = createDesktopCursorAuthAdapter({
      binaryPath: '/fake/cursor-agent',
      spawnProcess: () => child,
      runCommand,
      loginTimeoutMs: 60_000,
      forceSettleMs: 20,
      killProcessTree: killTree,
    });

    const loginPromise = adapter.triggerLogin();
    await Promise.resolve();
    await adapter.logout();
    order.push('logout-done');
    await loginPromise;

    expect(order).toEqual(['kill', 'logout', 'logout-done']);
    expect(killTree).toHaveBeenCalled();
  });
});
