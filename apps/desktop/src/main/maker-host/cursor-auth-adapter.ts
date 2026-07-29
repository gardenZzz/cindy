/**
 * Desktop Cursor AuthAdapter —— 委托本机 `cursor-agent status|login|logout`。
 *
 * 凭证只由 cursor CLI 自身管理（macOS Keychain）。本适配器：
 *  - 不落盘任何 cursor 凭证 / token
 *  - getAuthEnv() 恒返回 {}（鉴权不走 env 注入）
 *  - 日志不记录登录 URL / token
 *
 * 登录使用 `NO_OPEN_BROWSER=1`，把 URL 经 onProgress 交给 UI，由用户自愿打开。
 */

import { spawn, execFile, type ChildProcess } from 'node:child_process';

import type {
  AuthAdapter,
  AuthLoginOptions,
  AuthState,
} from '@cindy/maker-core';

import { createLogger } from '../logger.js';

const log = createLogger('cursor-auth-adapter');

const STATUS_TIMEOUT_MS = 15_000;
const LOGOUT_TIMEOUT_MS = 30_000;
/** 浏览器授权可能较长；cancelLogin 可提前结束。 */
const LOGIN_TIMEOUT_MS = 10 * 60_000;

const LOGIN_URL_RE = /https:\/\/[^\s<>"']+/i;

export interface CursorAuthCommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface CursorAuthAdapterDeps {
  binaryPath: string;
  /** 可注入：单测用假二进制，避免碰真实 Keychain。 */
  runCommand?: (
    args: string[],
    options: { env?: NodeJS.ProcessEnv; timeoutMs: number },
  ) => Promise<CursorAuthCommandResult>;
  spawnProcess?: (
    args: string[],
    options: { env: NodeJS.ProcessEnv },
  ) => ChildProcess;
}

function defaultRunCommand(
  binaryPath: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<CursorAuthCommandResult> {
  return new Promise((resolve) => {
    execFile(
      binaryPath,
      args,
      {
        env: options.env,
        timeout: options.timeoutMs,
        maxBuffer: 1024 * 1024,
        encoding: 'utf8',
      },
      (err, stdout, stderr) => {
        let code = 0;
        if (err) {
          const errCode = (err as NodeJS.ErrnoException & { code?: string | number }).code;
          code = typeof errCode === 'number' ? errCode : 1;
        }
        resolve({
          stdout: typeof stdout === 'string' ? stdout : String(stdout ?? ''),
          stderr: typeof stderr === 'string' ? stderr : String(stderr ?? ''),
          code,
        });
      },
    );
  });
}

function redactLoginProgress(chunk: string): string {
  return chunk.replace(LOGIN_URL_RE, '<login-url>');
}

function extractLoginUrl(text: string): string | null {
  const match = text.match(LOGIN_URL_RE);
  if (!match) return null;
  return match[0].replace(/[.,;:!?)]+$/, '');
}

function parseStatusJson(stdout: string): AuthState {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return { authenticated: false, errorReason: 'no_credentials' };
  }
  try {
    const parsed = JSON.parse(trimmed) as {
      isAuthenticated?: unknown;
      status?: unknown;
      userInfo?: { email?: unknown };
    };
    const authenticated =
      parsed.isAuthenticated === true || parsed.status === 'authenticated';
    if (!authenticated) {
      return { authenticated: false, errorReason: 'no_credentials' };
    }
    const email =
      typeof parsed.userInfo?.email === 'string' && parsed.userInfo.email.length > 0
        ? parsed.userInfo.email
        : undefined;
    return {
      authenticated: true,
      identity: email,
      authSource: 'oauth',
    };
  } catch {
    // 文本回退：`✓ Logged in as …`
    if (/logged in/i.test(trimmed) && !/not logged in/i.test(trimmed)) {
      const asMatch = trimmed.match(/logged in as\s+(\S+)/i);
      return {
        authenticated: true,
        identity: asMatch?.[1],
        authSource: 'oauth',
      };
    }
    return { authenticated: false, errorReason: 'no_credentials' };
  }
}

export class DesktopCursorAuthAdapter implements AuthAdapter {
  private readonly binaryPath: string;
  private readonly runCommand: NonNullable<CursorAuthAdapterDeps['runCommand']>;
  private readonly spawnProcess: NonNullable<CursorAuthAdapterDeps['spawnProcess']>;
  private loginChild: ChildProcess | null = null;
  private loginWaiters: Array<() => void> = [];

  constructor(deps: CursorAuthAdapterDeps) {
    this.binaryPath = deps.binaryPath;
    this.runCommand =
      deps.runCommand ??
      ((args, options) => defaultRunCommand(this.binaryPath, args, options));
    this.spawnProcess =
      deps.spawnProcess ??
      ((args, options) =>
        spawn(this.binaryPath, args, {
          env: options.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        }));
  }

  async getState(): Promise<AuthState> {
    try {
      const result = await this.runCommand(['status', '--format', 'json'], {
        env: { ...process.env, NO_OPEN_BROWSER: '1' },
        timeoutMs: STATUS_TIMEOUT_MS,
      });
      const state = parseStatusJson(result.stdout || result.stderr);
      log.debug('cursor auth status', {
        authenticated: state.authenticated,
        hasIdentity: Boolean(state.identity),
        exitCode: result.code,
      });
      return state;
    } catch (err) {
      log.warn('cursor status failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return { authenticated: false, errorReason: 'no_credentials' };
    }
  }

  async triggerLogin(opts?: AuthLoginOptions): Promise<AuthState> {
    if (this.loginChild) {
      opts?.onProgress?.('login-pending');
      await this.waitForLoginChildExit();
      return this.getState();
    }

    opts?.onProgress?.('login-pending');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NO_OPEN_BROWSER: '1',
    };

    const child = this.spawnProcess(['login'], { env });
    this.loginChild = child;

    let stdoutBuf = '';
    let emittedUrl = false;
    let finished = false;

    const finish = () => {
      if (finished) return;
      finished = true;
      this.loginChild = null;
      const waiters = this.loginWaiters.splice(0);
      for (const w of waiters) w();
    };

    const onChunk = (stream: 'stdout' | 'stderr', chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (stream === 'stdout') stdoutBuf += text;
      opts?.onProgress?.(`${stream}:${text}`);
      if (!emittedUrl) {
        const url = extractLoginUrl(stdoutBuf) ?? extractLoginUrl(text);
        if (url) {
          emittedUrl = true;
          opts?.onProgress?.(`stdout:Open a browser and navigate to this link: ${url}`);
          log.info('cursor login URL emitted', {
            detail: redactLoginProgress(`link: ${url}`),
          });
        }
      }
    };

    child.stdout?.on('data', (c) => onChunk('stdout', c));
    child.stderr?.on('data', (c) => onChunk('stderr', c));

    const timeout = setTimeout(() => {
      log.warn('cursor login timed out; terminating child');
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }, LOGIN_TIMEOUT_MS);

    await new Promise<void>((resolve) => {
      child.once('error', (err) => {
        log.warn('cursor login process error', {
          error: err instanceof Error ? err.message : String(err),
        });
        finish();
        resolve();
      });
      child.once('close', (code) => {
        log.info('cursor login process exited', {
          code: code ?? -1,
          urlEmitted: emittedUrl,
        });
        finish();
        resolve();
      });
    }).finally(() => {
      clearTimeout(timeout);
      finish();
    });

    const state = await this.getState();
    if (!state.authenticated) {
      return {
        authenticated: false,
        errorReason: state.errorReason ?? 'no_credentials',
      };
    }
    return state;
  }

  cancelLogin(): void {
    const child = this.loginChild;
    if (!child) return;
    try {
      child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }

  async logout(): Promise<void> {
    this.cancelLogin();
    const result = await this.runCommand(['logout'], {
      env: { ...process.env, NO_OPEN_BROWSER: '1' },
      timeoutMs: LOGOUT_TIMEOUT_MS,
    });
    if (result.code !== 0) {
      const message = (result.stderr || result.stdout || 'cursor logout failed').trim();
      log.warn('cursor logout failed', { exitCode: result.code });
      throw new Error(message.slice(0, 200));
    }
    log.info('cursor logout completed');
  }

  async getAuthEnv(): Promise<Record<string, string>> {
    // cursor_login 走本机 Keychain；不向子进程注入任何凭证 env。
    return {};
  }

  private waitForLoginChildExit(): Promise<void> {
    if (!this.loginChild) return Promise.resolve();
    return new Promise((resolve) => {
      this.loginWaiters.push(resolve);
    });
  }
}

export function createDesktopCursorAuthAdapter(
  deps: CursorAuthAdapterDeps,
): DesktopCursorAuthAdapter {
  return new DesktopCursorAuthAdapter(deps);
}

/** 单测 / 诊断用：从 status 输出解析 AuthState（不触发子进程）。 */
export function parseCursorStatusOutputForTest(stdout: string): AuthState {
  return parseStatusJson(stdout);
}

/** 单测用：从登录输出抽 URL。 */
export function extractCursorLoginUrlForTest(text: string): string | null {
  return extractLoginUrl(text);
}
