import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';

import { OneShotError } from '../base-agent.js';
import { CURSOR_ONESHOT_DEFAULT_MODEL, runCursorOneShot } from './oneShot.js';

function fakeChild(opts: {
  stdout?: string;
  stderr?: string;
  code?: number | null;
  delayMs?: number;
}): ChildProcess & EventEmitter {
  const child = new EventEmitter() as ChildProcess & EventEmitter;
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  (child as { stdout: EventEmitter; stderr: EventEmitter }).stdout = stdout;
  (child as { stdout: EventEmitter; stderr: EventEmitter }).stderr = stderr;
  (child as { kill: (signal?: string) => boolean }).kill = vi.fn(() => {
    queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
    return true;
  });
  queueMicrotask(() => {
    if (opts.stdout) stdout.emit('data', opts.stdout);
    if (opts.stderr) stderr.emit('data', opts.stderr);
    const emitClose = () => child.emit('close', opts.code ?? 0);
    if (opts.delayMs) setTimeout(emitClose, opts.delayMs);
    else queueMicrotask(emitClose);
  });
  return child;
}

describe('runCursorOneShot', () => {
  it('spawns headless -p text with cheap default model', async () => {
    const spawnImpl = vi.fn((_bin: string, args: string[]) => {
      expect(args).toEqual([
        '-p',
        '--output-format',
        'text',
        '--model',
        CURSOR_ONESHOT_DEFAULT_MODEL,
        '--trust',
        '--force',
        'ping',
      ]);
      return fakeChild({ stdout: 'pong\n' });
    });
    await expect(
      runCursorOneShot({
        binaryPath: '/fake/cursor-agent',
        prompt: 'ping',
        spawnImpl: spawnImpl as unknown as typeof import('node:child_process').spawn,
      }),
    ).resolves.toBe('pong');
  });

  it('throws timeout OneShotError', async () => {
    const spawnImpl = vi.fn(() => fakeChild({ stdout: '', delayMs: 50 }));
    await expect(
      runCursorOneShot({
        binaryPath: '/fake/cursor-agent',
        prompt: 'x',
        timeoutMs: 5,
        spawnImpl: spawnImpl as unknown as typeof import('node:child_process').spawn,
      }),
    ).rejects.toBeInstanceOf(OneShotError);
  });

  it('throws malformed on empty success stdout', async () => {
    const spawnImpl = vi.fn(() => fakeChild({ stdout: '   ', code: 0 }));
    await expect(
      runCursorOneShot({
        binaryPath: '/fake/cursor-agent',
        prompt: 'x',
        spawnImpl: spawnImpl as unknown as typeof import('node:child_process').spawn,
      }),
    ).rejects.toMatchObject({ name: 'OneShotError', reason: 'malformed' });
  });
});
