/**
 * Cursor headless oneShot —— `cursor-agent -p --output-format text` + 便宜模型。
 *
 * 用于起标题等辅助任务；不开 ACP 会话、不进事件流。
 * 凭证仍走本机 Keychain（不改 HOME / 不落盘）。
 */

import { spawn } from 'node:child_process';
import os from 'node:os';

import { OneShotError } from '../base-agent.js';

/** 起标题等短任务默认模型（本机实测可用、相对便宜）。 */
export const CURSOR_ONESHOT_DEFAULT_MODEL = 'composer-2.5';

export interface RunCursorOneShotOptions {
  binaryPath: string;
  prompt: string;
  model?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** 单测注入。 */
  spawnImpl?: typeof spawn;
}

export async function runCursorOneShot(opts: RunCursorOneShotOptions): Promise<string> {
  const model = opts.model ?? CURSOR_ONESHOT_DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const cwd = opts.cwd ?? os.tmpdir();
  const spawnImpl = opts.spawnImpl ?? spawn;

  const args = [
    '-p',
    '--output-format',
    'text',
    '--model',
    model,
    '--trust',
    '--force',
    opts.prompt,
  ];

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let stdout = '';
    let stderr = '';

    const child = spawnImpl(opts.binaryPath, args, {
      cwd,
      env: opts.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const finish = (err: Error | null, text?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve(text ?? '');
    };

    const onAbort = () => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      finish(opts.signal?.reason instanceof Error ? opts.signal.reason : new Error('aborted'));
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
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
      if (timedOut) {
        finish(new OneShotError('timeout', `Cursor oneShot timed out after ${timeoutMs}ms`));
        return;
      }
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
