/**
 * Cursor headless oneShot —— `cursor-agent -p --output-format text` + 便宜模型。
 *
 * 用于起标题等辅助任务；不开 ACP 会话、不进事件流。
 * 凭证仍走本机 Keychain（不改 HOME / 不落盘）。
 *
 * 安全边界（无人值守辅助任务，不同于交互式 ACP）：
 *  - `--mode ask`：只读 Q&A，不编辑
 *  - `--sandbox enabled`：显式开 sandbox（**不**继承 ACP isolatedConfig 的 sandbox:disabled）
 *  - 隔离空 `--workspace`（mkdtemp）；`--trust` 仅信任该空目录、避免交互提示
 *  - **禁止** `--force` / `--yolo`
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OneShotError } from '../base-agent.js';

/** 起标题等短任务默认模型（本机实测可用、相对便宜）。 */
export const CURSOR_ONESHOT_DEFAULT_MODEL = 'composer-2.5';

/** SIGTERM 后等待再 SIGKILL 的宽限（与 ACP stdioTransport 同量级）。 */
export const CURSOR_ONESHOT_SIGTERM_GRACE_MS = 2_000;

export interface RunCursorOneShotOptions {
  binaryPath: string;
  prompt: string;
  model?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * 若传入则作为 `--workspace` / cwd（单测注入）；
   * 生产路径不传，内部 mkdtemp 隔离空目录。
   */
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** 单测可缩短 SIGTERM → SIGKILL 宽限。 */
  sigtermGraceMs?: number;
  /** 单测注入。 */
  spawnImpl?: typeof spawn;
}

/** TERM → grace → KILL；不假设 close 一定跟上（Windows 尤其如此）。 */
export function terminateCursorOneShotChild(
  child: ChildProcess,
  graceMs: number = CURSOR_ONESHOT_SIGTERM_GRACE_MS,
): void {
  try {
    child.kill('SIGTERM');
  } catch {
    /* already gone */
  }
  const timer = setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }, graceMs);
  timer.unref?.();
}

function cleanupWorkspace(dir: string, owned: boolean): void {
  if (!owned) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

export async function runCursorOneShot(opts: RunCursorOneShotOptions): Promise<string> {
  const model = opts.model ?? CURSOR_ONESHOT_DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const sigtermGraceMs = opts.sigtermGraceMs ?? CURSOR_ONESHOT_SIGTERM_GRACE_MS;
  const spawnImpl = opts.spawnImpl ?? spawn;

  const ownedWorkspace = opts.cwd === undefined;
  const workspaceDir =
    opts.cwd ?? mkdtempSync(join(tmpdir(), 'cindy-cursor-oneshot-'));

  // ask + sandbox enabled：无人值守辅助任务；禁止 force/yolo。
  const args = [
    '-p',
    '--output-format',
    'text',
    '--model',
    model,
    '--mode',
    'ask',
    '--sandbox',
    'enabled',
    '--trust',
    '--workspace',
    workspaceDir,
    opts.prompt,
  ];

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let stdout = '';
    let stderr = '';

    const child = spawnImpl(opts.binaryPath, args, {
      cwd: workspaceDir,
      env: opts.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const finish = (err: Error | null, text?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      cleanupWorkspace(workspaceDir, ownedWorkspace);
      if (err) reject(err);
      else resolve(text ?? '');
    };

    const onAbort = () => {
      terminateCursorOneShotChild(child, sigtermGraceMs);
      // 立刻结算；不依赖 close（子进程可能忽略 SIGTERM 变孤儿，后台继续 KILL）。
      finish(opts.signal?.reason instanceof Error ? opts.signal.reason : new Error('aborted'));
    };

    const timer = setTimeout(() => {
      terminateCursorOneShotChild(child, sigtermGraceMs);
      finish(new OneShotError('timeout', `Cursor oneShot timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    if (opts.signal) {
      if (opts.signal.aborted) {
        onAbort();
        return;
      }
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    });
    child.once('error', (err) => {
      finish(new OneShotError('network', err.message));
    });
    child.once('close', (code) => {
      // 超时 / abort 已在 deadline 结算；迟到的 close 只忽略。
      if (settled) return;
      if (opts.signal?.aborted) {
        finish(opts.signal.reason instanceof Error ? opts.signal.reason : new Error('aborted'));
        return;
      }
      const text = stdout.trim();
      if (code !== 0 && !text) {
        const detail = (stderr || stdout || `exit ${code ?? -1}`).trim().slice(0, 300);
        finish(new OneShotError('malformed', `Cursor oneShot failed: ${detail}`));
        return;
      }
      if (!text) {
        finish(new OneShotError('malformed', 'Empty response from Cursor oneShot'));
        return;
      }
      finish(null, text);
    });
  });
}
