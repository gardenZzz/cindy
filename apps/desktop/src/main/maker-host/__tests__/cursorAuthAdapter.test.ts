import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawn: (...args: unknown[]) => spawnMock(...args),
  };
});

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

  it('logout clears the identity cached in per-session isolated config dirs', async () => {
    // CLI 的 logout 只清全局目录与 Keychain；按会话隔离的 CURSOR_CONFIG_DIR 里
    // 上游缓存的 authInfo 够不着，不显式清就会留着上一个账号的身份。
    const userDataPath = mkdtempSync(join(tmpdir(), 'cindy-cursor-logout-'));
    try {
      const sessionDir = join(userDataPath, 'cursor-acp', 'sess-a-abcdef012345');
      mkdirSync(join(sessionDir, 'acp-sessions', 'upstream-id'), { recursive: true });
      writeFileSync(
        join(sessionDir, 'cli-config.json'),
        JSON.stringify({ approvalMode: 'allowlist', authInfo: { email: 'nobody@example.invalid' } }),
      );
      writeFileSync(join(sessionDir, 'acp-sessions', 'upstream-id', 'meta.json'), '{}');

      const adapter = createDesktopCursorAuthAdapter({
        binaryPath: '/fake/cursor-agent',
        runCommand: async () => ({ stdout: '', stderr: '', code: 0 }),
        userDataPath,
      });
      await adapter.logout();

      expect(existsSync(join(sessionDir, 'cli-config.json'))).toBe(false);
      // resume 依据不受影响。
      expect(existsSync(join(sessionDir, 'acp-sessions', 'upstream-id', 'meta.json'))).toBe(true);
    } finally {
      rmSync(userDataPath, { recursive: true, force: true });
    }
  });

  it('keeps logout succeeding when the isolated config cleanup finds nothing', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'cindy-cursor-logout-empty-'));
    try {
      const adapter = createDesktopCursorAuthAdapter({
        binaryPath: '/fake/cursor-agent',
        runCommand: async () => ({ stdout: '', stderr: '', code: 0 }),
        userDataPath,
      });
      await expect(adapter.logout()).resolves.toBeUndefined();
    } finally {
      rmSync(userDataPath, { recursive: true, force: true });
    }
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

  /**
   * 修复前会失败：timeout 立刻 settle() 清空 activeLogin，logout 看到 null 直接跑
   * cursor logout，不等 killTree onSettled。本测用延迟 onSettled 制造窗口。
   */
  it('after login timeout, logout waits until killTree onSettled (not race ahead)', async () => {
    const { child } = hangingLoginChild({ killIgnoresClose: true });
    const pendingOnSettled: Array<() => void> = [];
    const order: string[] = [];
    const killTree = vi.fn((_pid: number | undefined, _proc: ChildProcess, onSettled?: () => void) => {
      order.push('kill-started');
      if (onSettled) pendingOnSettled.push(onSettled);
      // 故意不立刻 onSettled：模拟 Windows taskkill 重试/后代兜底仍在进行
    });
    const runCommand = vi.fn(async (args: string[]) => {
      if (args[0] === 'logout') {
        order.push('logout-cli');
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
      loginTimeoutMs: 30,
      forceSettleMs: 5_000,
      killProcessTree: killTree,
    });

    const state = await adapter.triggerLogin();
    expect(state.authenticated).toBe(false);
    expect(killTree).toHaveBeenCalled();
    order.push('login-returned');

    let logoutFinished = false;
    const logoutPromise = adapter.logout().then(() => {
      logoutFinished = true;
      order.push('logout-done');
    });

    // 让 logout 的 cancel/wait 挂上；此时 kill 尚未 onSettled，不得抢跑 logout CLI
    await Promise.resolve();
    await Promise.resolve();
    expect(logoutFinished).toBe(false);
    expect(order).not.toContain('logout-cli');

    // 收口：先完成 killTree，再 close 释放 reservation（forceSettleMs 故意设大，不靠它）
    for (const cb of pendingOnSettled.splice(0)) cb();
    child.emit('close', null);

    await logoutPromise;
    expect(logoutFinished).toBe(true);
    expect(order).toEqual([
      'kill-started',
      'login-returned',
      'kill-started', // logout→cancelLogin 再次 terminate
      'logout-cli',
      'logout-done',
    ]);
  });

  /**
   * 修复前会失败：默认 spawn 未设 detached，POSIX 下 kill(-pid) 打不中进程组。
   */
  it('default spawnProcess sets detached for process-group kill contract', async () => {
    const { child } = hangingLoginChild();
    spawnMock.mockReset();
    spawnMock.mockReturnValue(child);

    const adapter = createDesktopCursorAuthAdapter({
      binaryPath: '/fake/cursor-agent',
      // 不注入 spawnProcess，走构造函数默认实现
      runCommand: async () => ({
        stdout: JSON.stringify({ isAuthenticated: false }),
        stderr: '',
        code: 0,
      }),
      loginTimeoutMs: 60_000,
      killProcessTree: (_pid, proc, onSettled) => {
        proc.kill('SIGKILL');
        onSettled?.();
      },
    });

    const loginPromise = adapter.triggerLogin();
    await Promise.resolve();
    expect(spawnMock).toHaveBeenCalled();
    const spawnOpts = spawnMock.mock.calls[0]?.[2] as { detached?: boolean };
    expect(spawnOpts.detached).toBe(process.platform !== 'win32');

    child.emit('close', 0);
    await loginPromise;
  });
});
