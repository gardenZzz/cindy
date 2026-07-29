/**
 * StdioTransport — 本地 spawn Agent CLI, 接 stdin/stdout NDJSON 流。
 *
 * 与 codex app-server/stdioTransport 同构; args 由调用方注入
 * (Cursor: `['acp']`), 本层不认识任何 vendor 子命令。
 *
 * close() 保证: stdin EOF → SIGTERM → 等待 → SIGKILL，避免 PPID=1 孤儿；
 * 信号发给整个 process group，孙进程一并收掉 (见 killTree)。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import process from 'node:process';
import { createInterface, type Interface } from 'node:readline';
import type {
  CloseHandler,
  LineHandler,
  StderrHandler,
  Transport,
} from './transport.js';

/** SIGTERM 后等待子进程退出的上限；超时再 SIGKILL。 */
export const ACP_STDIO_SIGTERM_GRACE_MS = 2_000;
/** SIGKILL 后再等一轮，确认进程消失。 */
export const ACP_STDIO_SIGKILL_WAIT_MS = 1_000;

export interface AcpStdioTransportOptions {
  /** Agent CLI 可执行文件的绝对路径 (host 已发现 / provisioned)。 */
  binaryPath: string;
  /** 传给二进制的 argv (含子命令)。Cursor: `['acp']`。 */
  args: string[];
  /** 子进程 cwd; 不传则继承父进程 cwd。 */
  cwd?: string;
  /** 子进程 env。 */
  env?: NodeJS.ProcessEnv;
  /** 单测可缩短 SIGTERM 宽限。 */
  sigtermGraceMs?: number;
  /** 单测可缩短 SIGKILL 等待。 */
  sigkillWaitMs?: number;
}

function waitForChildExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      resolve(exited);
    };
    const onExit = () => done(true);
    const timer = setTimeout(() => done(false), timeoutMs);
    timer.unref?.();
    child.once('exit', onExit);
  });
}

export function createAcpStdioTransport(opts: AcpStdioTransportOptions): Transport {
  if (!opts.binaryPath) {
    throw new Error('createAcpStdioTransport: binaryPath is required');
  }
  if (!Array.isArray(opts.args)) {
    throw new Error('createAcpStdioTransport: args is required');
  }

  const sigtermGraceMs = opts.sigtermGraceMs ?? ACP_STDIO_SIGTERM_GRACE_MS;
  const sigkillWaitMs = opts.sigkillWaitMs ?? ACP_STDIO_SIGKILL_WAIT_MS;

  const lineHandlers = new Set<LineHandler>();
  const stderrHandlers = new Set<StderrHandler>();
  const closeHandlers = new Set<CloseHandler>();
  /**
   * Lines arrive at readline 'line' event whether anyone listens or not. Buffer
   * them until the FIRST onLine subscriber registers, then drain in order.
   */
  const lineBuffer: string[] = [];
  let lineHandlerArmed = false;
  let closed = false;
  let closePromise: Promise<void> | null = null;

  /**
   * detached 让子进程自成 process group leader，close() 才能把信号发给整组。
   * 只 kill 直系子进程是不够的: `cursor-agent acp` 会 fork 出 worker-server,
   * 父进程死后它挂到 PPID=1，实测存活 3–5 分钟 (RSS ~190MB) 才自行退出。
   * Windows 没有 POSIX 进程组语义、负 pid kill 不可用，改用 `taskkill /T /F`
   * 树杀 (与 desktop scheduler-host/proc-util 同款结论)。注意那边必须**第一次就用**
   * taskkill: Windows 上 `child.kill()` 会立刻干掉父进程，树随即失去锚点，
   * 再想按父 pid 找后代就晚了，所以 Windows 分支没有「先温和后强制」两段。
   */
  const useProcessGroup = process.platform !== 'win32';

  const child: ChildProcessWithoutNullStreams = spawn(opts.binaryPath, opts.args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    detached: useProcessGroup,
  });

  /** 连子孙一起收；手段不可用时退回直系子进程 kill。 */
  const killTree = (signal: NodeJS.Signals): void => {
    const pid = child.pid;
    if (typeof pid !== 'number') return;
    if (useProcessGroup) {
      try {
        process.kill(-pid, signal);
        return;
      } catch { /* 组已消失，退回单进程 */ }
    } else {
      // ⚠️ 未在 Windows 上实测过（开发机为 macOS）。taskkill 拉不起来时
      // ('error' 事件) 回落单进程 kill，至少不比修复前差。
      try {
        const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
        killer.on('error', () => {
          try { child.kill(signal); } catch { /* swallow */ }
        });
        return;
      } catch { /* spawn 同步抛，回落单进程 */ }
    }
    try { child.kill(signal); } catch { /* swallow */ }
  };

  /** 组内还有活着的成员吗——直系子进程已退出但孙进程仍在时为 true。 */
  const treeAlive = (): boolean => {
    const pid = child.pid;
    if (typeof pid !== 'number') return false;
    if (!useProcessGroup) {
      return child.exitCode === null && child.signalCode === null;
    }
    try {
      process.kill(-pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  child.stdout.setEncoding('utf8');
  const rl: Interface = createInterface({
    input: child.stdout,
    crlfDelay: Infinity,
  });
  rl.on('line', (line) => {
    if (!lineHandlerArmed) {
      lineBuffer.push(line);
      return;
    }
    for (const cb of lineHandlers) cb(line);
  });

  child.stderr.setEncoding('utf8');
  let stderrBuffer = '';
  child.stderr.on('data', (chunk: string) => {
    stderrBuffer += chunk;
    const idx = stderrBuffer.lastIndexOf('\n');
    if (idx === -1) return;
    const lines = stderrBuffer.slice(0, idx).split('\n');
    stderrBuffer = stderrBuffer.slice(idx + 1);
    for (const line of lines) {
      const trimmed = line.replace(/\r$/, '');
      if (!trimmed) continue;
      for (const cb of stderrHandlers) cb(trimmed);
    }
  });

  const fireClose = (reason: string): void => {
    if (closed) return;
    closed = true;
    try { rl.close(); } catch { /* already closed */ }
    for (const cb of closeHandlers) {
      try { cb({ reason }); } catch { /* handler should not throw */ }
    }
  };

  child.on('error', (err) => {
    fireClose(`child error: ${err.message}`);
  });
  child.on('exit', (code, signal) => {
    const reason = signal ? `signal=${signal}` : `exit code=${code ?? 'null'}`;
    fireClose(`child exited (${reason})`);
  });

  return {
    writeLine(line: string): Promise<void> {
      if (closed || !child.stdin.writable) {
        return Promise.reject(new Error('AcpStdioTransport.writeLine after close'));
      }
      return new Promise<void>((resolve, reject) => {
        child.stdin.write(line + '\n', 'utf8', (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },

    onLine(handler: LineHandler): () => void {
      lineHandlers.add(handler);
      if (!lineHandlerArmed) {
        lineHandlerArmed = true;
        if (lineBuffer.length > 0) {
          const drained = lineBuffer.splice(0);
          for (const line of drained) {
            for (const cb of lineHandlers) cb(line);
          }
        }
      }
      return () => { lineHandlers.delete(handler); };
    },

    onStderr(handler: StderrHandler): () => void {
      stderrHandlers.add(handler);
      return () => { stderrHandlers.delete(handler); };
    },

    onClose(handler: CloseHandler): () => void {
      closeHandlers.add(handler);
      return () => { closeHandlers.delete(handler); };
    },

    getPid(): number | null {
      if (child.exitCode !== null || child.signalCode !== null) return null;
      return typeof child.pid === 'number' ? child.pid : null;
    },

    async close(reason = 'AcpStdioTransport.close()'): Promise<void> {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        try { child.stdin.end(); } catch { /* swallow */ }

        // 无条件对整组发信号: 直系子进程可能已退出而孙进程还活着，
        // 按 child.exitCode 短路会漏掉后者。
        killTree('SIGTERM');
        await waitForChildExit(child, sigtermGraceMs);
        if (treeAlive()) {
          killTree('SIGKILL');
          await waitForChildExit(child, sigkillWaitMs);
        }

        fireClose(reason);
      })();
      return closePromise;
    },
  };
}
