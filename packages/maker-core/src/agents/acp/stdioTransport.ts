/**
 * StdioTransport — 本地 spawn Agent CLI, 接 stdin/stdout NDJSON 流。
 *
 * 与 codex app-server/stdioTransport 同构; args 由调用方注入
 * (Cursor: `['acp']`), 本层不认识任何 vendor 子命令。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import type {
  CloseHandler,
  LineHandler,
  StderrHandler,
  Transport,
} from './transport.js';

export interface AcpStdioTransportOptions {
  /** Agent CLI 可执行文件的绝对路径 (host 已发现 / provisioned)。 */
  binaryPath: string;
  /** 传给二进制的 argv (含子命令)。Cursor: `['acp']`。 */
  args: string[];
  /** 子进程 cwd; 不传则继承父进程 cwd。 */
  cwd?: string;
  /** 子进程 env。 */
  env?: NodeJS.ProcessEnv;
}

export function createAcpStdioTransport(opts: AcpStdioTransportOptions): Transport {
  if (!opts.binaryPath) {
    throw new Error('createAcpStdioTransport: binaryPath is required');
  }
  if (!Array.isArray(opts.args)) {
    throw new Error('createAcpStdioTransport: args is required');
  }

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

    async close(reason = 'AcpStdioTransport.close()'): Promise<void> {
      if (closed) return;
      try { child.stdin.end(); } catch { /* swallow */ }
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGTERM'); } catch { /* swallow */ }
      }
      fireClose(reason);
    },
  };
}
