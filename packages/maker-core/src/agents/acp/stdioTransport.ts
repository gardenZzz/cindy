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
  /**
   * 单测用：覆盖平台判定。Windows 终止分支在 macOS 开发机与 ubuntu CI 上都跑不到，
   * 不给这个缝就只能靠人肉阅读保证它不回归。
   */
  platformOverride?: NodeJS.Platform;
  /** 单测用：注入 taskkill 的 spawn，配合 platformOverride 压 Windows 分支。 */
  taskkillSpawner?: TaskkillSpawner;
}

/**
 * taskkill 子进程里本函数用到的那部分（避免为测试引入 ChildProcess 全量类型）。
 * 单签名而非按事件重载：真实 ChildProcess 的 `on(event: string, ...)` 重载可赋值
 * 给它，而假对象也能用一个实现同时满足——重载会让后者无法通过类型检查。
 * `code` 可选是为了让 'error' 监听器也匹配同一签名。
 */
export interface TaskkillHandle {
  on(event: 'error' | 'exit', listener: (code?: number | null) => void): unknown;
}

export type TaskkillSpawner = (pid: number) => TaskkillHandle;

const defaultTaskkillSpawner: TaskkillSpawner = (pid) =>
  spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
    windowsHide: true,
    stdio: 'ignore',
  });

/**
 * Windows 树杀：一次 `taskkill /PID <pid> /T /F`，失败回落单进程 kill。
 *
 * 两条失败路径都必须接：`'error'` **只**在 taskkill 自身起不来时触发 (ENOENT 等)，
 * 而真正常见的失败——正常启动但因访问被拒 / 进程表竞态返回非零——只走 `'exit'`
 * (实测 exit 7 时 error 不触发)。只听 error 会让 close() 伪成功、ACP 树残留。
 *
 * 抽成独立导出是为了能在非 Windows 机器上注入 spawner 验证回落：该分支在开发机
 * (macOS) 与 CI (ubuntu-latest) 上都永远跑不到，不给缝就等于没有测试。
 */
export function killWindowsTree(
  pid: number,
  signal: NodeJS.Signals,
  killDirect: (signal: NodeJS.Signals) => void,
  spawnTaskkill: TaskkillSpawner = defaultTaskkillSpawner,
): void {
  let fellBack = false;
  const fallback = (): void => {
    if (fellBack) return;
    fellBack = true;
    killDirect(signal);
  };
  try {
    const killer = spawnTaskkill(pid);
    killer.on('error', fallback);
    killer.on('exit', (code) => {
      if (code !== 0) fallback();
    });
  } catch {
    // spawn 同步抛。
    fallback();
  }
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
   * 树杀 (与 desktop scheduler-host/proc-util 同款结论，实现见 killWindowsTree)。
   * 注意那边必须**第一次就用** taskkill: Windows 上 `child.kill()` 会立刻干掉
   * 父进程，树随即失去锚点，再想按父 pid 找后代就晚了，所以 Windows 分支没有
   * 「先温和后强制」两段——close() 按平台分岔，见其中的注释。
   */
  const useProcessGroup = (opts.platformOverride ?? process.platform) !== 'win32';

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
      killWindowsTree(
        pid,
        signal,
        (s) => {
          try { child.kill(s); } catch { /* swallow */ }
        },
        opts.taskkillSpawner,
      );
      return;
    }
    try { child.kill(signal); } catch { /* swallow */ }
  };

  /**
   * 组内还有活着的成员吗——直系子进程已退出但孙进程仍在时为 true。
   * **仅 POSIX**：Windows 没有进程组语义，close() 的 win32 分支不走这里。
   */
  const processGroupAlive = (): boolean => {
    const pid = child.pid;
    if (typeof pid !== 'number') return false;
    try {
      process.kill(-pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  /** 直系子进程是否还活着（Windows 没有进程组可探，只能看它）。 */
  const childAlive = (): boolean =>
    child.exitCode === null && child.signalCode === null;

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

        if (useProcessGroup) {
          // POSIX: 先整组 TERM，再按**组内是否还有成员**决定是否升级 KILL。
          // 无条件发信号而不按 child.exitCode 短路：直系子进程可能已退出而
          // 孙进程还活着，短路会漏掉后者。
          killTree('SIGTERM');
          await waitForChildExit(child, sigtermGraceMs);
          if (processGroupAlive()) {
            killTree('SIGKILL');
            await waitForChildExit(child, sigkillWaitMs);
          }
        } else {
          // Windows: `taskkill /T /F` 本身就是强制树杀，不存在「先温和后强制」
          // 可分的两段，所以只发一次 + 有界等待，失败由 killWindowsTree 内部回落
          // 直系 kill。
          //
          // 之所以不能沿用上面的两段式：那样第一次已经发了带 /F 的 taskkill，
          // grace 内 direct child 的 exit 若还没到，存活探测仍为 true，就会
          // 再 spawn 一个 taskkill 与前一个并发操作同一 PID 树；第二个若因竞态
          // 失败还会直接 kill leader，在第一个尚未收割完后代时打掉锚点，反而可能
          // 重新留下 worker-server。
          killTree('SIGKILL');
          await waitForChildExit(child, sigtermGraceMs + sigkillWaitMs);
          // taskkill **挂住**（既不 exit 也不 error）时，killWindowsTree 内部的
          // 两个回落条件一个都不触发，close() 会在等满后照常 fireClose，调用方
          // 以为已关而进程仍在——这是「伪成功」的第三个入口。超时按同一条回落
          // 处理：不是重试 taskkill，而是把 timeout 也算作它失败。
          if (childAlive()) {
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
