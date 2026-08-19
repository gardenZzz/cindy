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
import { killProcessTree } from '../scheduler-host/proc-util.js';

const log = createLogger('cursor-auth-adapter');

const STATUS_TIMEOUT_MS = 15_000;
const LOGOUT_TIMEOUT_MS = 30_000;
/** 浏览器授权可能较长；cancelLogin 可提前结束。 */
const LOGIN_TIMEOUT_MS = 10 * 60_000;
/** kill 后若 close 永不来，强制结算 login Promise / logout 等待。 */
const LOGIN_FORCE_SETTLE_MS = 1_500;
/** getState 默认缓存窗口；登录结算与登出主动作废。 */
const STATE_TTL_MS = 60_000;

const LOGIN_URL_RE = /https:\/\/[^\s<>"']+/i;

export interface CursorAuthCommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type CursorKillProcessTree = (
  pid: number | undefined,
  child: ChildProcess,
  onSettled?: () => void,
) => void;

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
  /** 单测可缩短登录超时。 */
  loginTimeoutMs?: number;
  /** 单测可缩短 kill→强制结算窗口。 */
  forceSettleMs?: number;
  /** 单测注入跨平台终止（默认复用 scheduler-host killProcessTree）。 */
  killProcessTree?: CursorKillProcessTree;
  /** 单测可注入时钟，配合 stateTtlMs 验证过期。 */
  now?: () => number;
  /** 单测可缩短 getState TTL。 */
  stateTtlMs?: number;
}

interface ActiveLoginSession {
  child: ChildProcess;
  /** 幂等：清 loginChild、唤醒 waiters、解开 triggerLogin 的 exit await。 */
  settle: () => void;
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
  private readonly loginTimeoutMs: number;
  private readonly forceSettleMs: number;
  private readonly killTree: CursorKillProcessTree;
  private readonly now: () => number;
  private readonly stateTtlMs: number;
  private cachedState: { state: AuthState; expiresAt: number } | null = null;
  private activeLogin: ActiveLoginSession | null = null;
  private loginWaiters: Array<() => void> = [];
  private forceSettleTimers = new Set<ReturnType<typeof setTimeout>>();

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
          // POSIX: 自成进程组，killProcessTree 的 kill(-pid) 才能连 CLI 后代一起收割。
          // Windows 忽略 detached，树杀走 taskkill /T（见 proc-util）。
          detached: process.platform !== 'win32',
        }));
    this.loginTimeoutMs = deps.loginTimeoutMs ?? LOGIN_TIMEOUT_MS;
    this.forceSettleMs = deps.forceSettleMs ?? LOGIN_FORCE_SETTLE_MS;
    this.killTree = deps.killProcessTree ?? killProcessTree;
    this.now = deps.now ?? Date.now;
    this.stateTtlMs = deps.stateTtlMs ?? STATE_TTL_MS;
  }

  async getState(): Promise<AuthState> {
    const now = this.now();
    if (this.cachedState && now < this.cachedState.expiresAt) {
      return this.cachedState.state;
    }
    const state = await this.fetchState();
    this.cachedState = { state, expiresAt: now + this.stateTtlMs };
    return state;
  }

  private invalidateStateCache(): void {
    this.cachedState = null;
  }

  private async fetchState(): Promise<AuthState> {
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
    this.invalidateStateCache();
    if (this.activeLogin) {
      opts?.onProgress?.('login-pending');
      await this.waitForLoginChildExit();
      this.invalidateStateCache();
      return this.getState();
    }

    opts?.onProgress?.('login-pending');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NO_OPEN_BROWSER: '1',
    };

    const child = this.spawnProcess(['login'], { env });

    let stdoutBuf = '';
    let emittedUrl = false;
    /** 用户态 login Promise 是否已返回（timeout 可先于进程收口）。 */
    let userResolved = false;
    /** 进程 cleanup reservation（activeLogin）是否已释放。 */
    let cleanupReleased = false;
    let forceSettleTimer: ReturnType<typeof setTimeout> | null = null;
    let resolveExit!: () => void;

    const resolveUser = () => {
      if (userResolved) return;
      userResolved = true;
      resolveExit();
    };

    /**
     * 释放 cleanup reservation：清 activeLogin、唤醒 logout/新 login 等待者，
     * 并顺带解开用户态 Promise（若尚未因 timeout 返回）。
     * timeout 路径只调 resolveUser，必须等 close / kill onSettled→force settle 才到这里。
     */
    const releaseCleanup = () => {
      if (cleanupReleased) return;
      cleanupReleased = true;
      if (forceSettleTimer) {
        clearTimeout(forceSettleTimer);
        this.forceSettleTimers.delete(forceSettleTimer);
        forceSettleTimer = null;
      }
      if (this.activeLogin?.child === child) this.activeLogin = null;
      const waiters = this.loginWaiters.splice(0);
      for (const w of waiters) w();
      resolveUser();
    };

    this.activeLogin = { child, settle: releaseCleanup };

    const exitPromise = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });

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

    child.once('error', (err) => {
      log.warn('cursor login process error', {
        error: err instanceof Error ? err.message : String(err),
      });
      releaseCleanup();
    });
    child.once('close', (code) => {
      log.info('cursor login process exited', {
        code: code ?? -1,
        urlEmitted: emittedUrl,
      });
      releaseCleanup();
    });

    const armForceSettleAfterKill = () => {
      // 只能在 killProcessTree onSettled 里武装（见 proc-util），不能与 kill 并行起跑。
      if (forceSettleTimer || cleanupReleased) return;
      forceSettleTimer = setTimeout(() => {
        this.forceSettleTimers.delete(forceSettleTimer!);
        forceSettleTimer = null;
        if (!cleanupReleased) {
          log.warn('cursor login force-settled after kill without close');
          releaseCleanup();
        }
      }, this.forceSettleMs);
      forceSettleTimer.unref?.();
      this.forceSettleTimers.add(forceSettleTimer);
    };

    const timeout = setTimeout(() => {
      log.warn('cursor login timed out; terminating child');
      this.terminateLoginChild(child, armForceSettleAfterKill);
      // deadline 只结算用户态 Promise；activeLogin 留到 close / force settle。
      resolveUser();
    }, this.loginTimeoutMs);

    try {
      await exitPromise;
    } finally {
      clearTimeout(timeout);
      // 不在此处 clear forceSettleTimer / releaseCleanup：
      // timeout 后用户态已返回，但 kill 可能仍在收敛，reservation 须留到收口。
    }

    this.invalidateStateCache();
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
    const session = this.activeLogin;
    if (!session) return;
    this.terminateLoginChild(session.child, () => {
      // kill 完成后若 close 仍不来，强制 settle（解开 triggerLogin / logout 等待）。
      const timer = setTimeout(() => {
        this.forceSettleTimers.delete(timer);
        if (!session) return;
        log.warn('cursor login cancel force-settled without close');
        session.settle();
      }, this.forceSettleMs);
      timer.unref?.();
      this.forceSettleTimers.add(timer);
    });
  }

  async logout(): Promise<void> {
    this.invalidateStateCache();
    if (this.activeLogin) {
      this.cancelLogin();
      await this.waitForLoginChildExit();
    }
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

  private terminateLoginChild(child: ChildProcess, onSettled?: () => void): void {
    try {
      this.killTree(child.pid, child, onSettled);
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      onSettled?.();
    }
  }

  private waitForLoginChildExit(): Promise<void> {
    if (!this.activeLogin) return Promise.resolve();
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
