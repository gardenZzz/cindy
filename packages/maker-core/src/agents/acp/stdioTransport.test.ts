/**
 * StdioTransport close 必须真正杀掉子进程，避免 PPID=1 孤儿。
 */

import { describe, expect, it } from 'vitest';
import process from 'node:process';

import { createAcpStdioTransport } from './stdioTransport.js';

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('createAcpStdioTransport orphan cleanup', () => {
  it('close() SIGTERM/SIGKILL leaves no live child pid', async () => {
    const transport = createAcpStdioTransport({
      binaryPath: process.execPath,
      // Ignore SIGTERM briefly so we exercise the SIGKILL fallback path.
      args: [
        '-e',
        'process.on("SIGTERM",()=>{}); setInterval(()=>{}, 1000);',
      ],
      sigtermGraceMs: 100,
      sigkillWaitMs: 500,
    });

    const pid = transport.getPid?.();
    expect(pid, 'child pid').toBeTypeOf('number');
    expect(processAlive(pid!)).toBe(true);

    await transport.close('test orphan cleanup');

    // Give the OS a beat after SIGKILL.
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && processAlive(pid!)) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(processAlive(pid!), `pid ${pid} still alive after close`).toBe(false);
    expect(transport.getPid?.()).toBeNull();
  });

  it('close() is idempotent', async () => {
    const transport = createAcpStdioTransport({
      binaryPath: process.execPath,
      args: ['-e', 'setTimeout(()=>{}, 60_000)'],
      sigtermGraceMs: 500,
      sigkillWaitMs: 500,
    });
    const pid = transport.getPid?.();
    expect(pid).toBeTypeOf('number');
    await transport.close('first');
    await transport.close('second');
    expect(processAlive(pid!)).toBe(false);
  });
});
