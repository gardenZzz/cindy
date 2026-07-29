/**
 * StdioTransport — 本地 spawn Agent CLI, 接 stdin/stdout NDJSON 流。
 *
 * 与 codex app-server/stdioTransport 同构; args 由调用方注入
 * (Cursor: `['acp']`), 本层不认识任何 vendor 子命令。
 *
 * close() 保证: stdin EOF → SIGTERM → 等待 → SIGKILL，避免 PPID=1 孤儿。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
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

  const child: ChildProcessWithoutNullStreams = spawn(opts.binaryPath, opts.args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    detached: false,
  });

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

        if (child.exitCode === null && child.signalCode === null) {
          try { child.kill('SIGTERM'); } catch { /* swallow */ }
          const exited = await waitForChildExit(child, sigtermGraceMs);
          if (!exited && child.exitCode === null && child.signalCode === null) {
            try { child.kill('SIGKILL'); } catch { /* swallow */ }
            await waitForChildExit(child, sigkillWaitMs);
          }
        }

        fireClose(reason);
      })();
      return closePromise;
    },
  };
}
