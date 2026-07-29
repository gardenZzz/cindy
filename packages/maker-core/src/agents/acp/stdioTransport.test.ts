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

  /**
   * 真实拓扑: `cursor-agent acp` 自己 fork 出 worker-server。孙进程故意忽略 SIGTERM，
   * 顺带压 treeAlive() → SIGKILL 的升级路径。
   */
  async function bootWithGrandchild(): Promise<{
    transport: ReturnType<typeof createAcpStdioTransport>;
    leaderPid: number;
    grandchildPid: number;
  }> {
    const transport = createAcpStdioTransport({
      binaryPath: process.execPath,
      args: [
        '-e',
        'const{spawn}=require("node:child_process");' +
          'const g=spawn(process.execPath,["-e",' +
          '\'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)\'],{stdio:"ignore"});' +
          'process.stdout.write(JSON.stringify({grandchild:g.pid})+"\\n");' +
          'setInterval(()=>{},1000);',
      ],
      sigtermGraceMs: 300,
      sigkillWaitMs: 500,
    });
    const leaderPid = transport.getPid?.() as number;
    const grandchildPid = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no grandchild pid')), 10_000);
      transport.onLine((line) => {
        const pid = (JSON.parse(line) as { grandchild?: number }).grandchild;
        if (typeof pid === 'number') {
          clearTimeout(timer);
          resolve(pid);
        }
      });
    });
    return { transport, leaderPid, grandchildPid };
  }

  async function expectDeadWithin(pid: number, ms: number, label: string): Promise<void> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline && processAlive(pid)) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(processAlive(pid), `${label} (pid ${pid}) still alive`).toBe(false);
  }

  /**
   * 只 kill 直系子进程时孙进程挂到 PPID=1，实测存活 3–5 分钟才自行退出
   * ——第一个用例只看 direct child，看不见它。
   */
  it.skipIf(process.platform === 'win32')(
    'close() also reaps grandchildren spawned by the child',
    async () => {
      const { transport, grandchildPid } = await bootWithGrandchild();
      expect(processAlive(grandchildPid)).toBe(true);

      await transport.close('test grandchild cleanup');

      await expectDeadWithin(grandchildPid, 3000, 'grandchild orphaned after close');
    },
    20_000,
  );

  /**
   * leader 先被硬杀（= resume e2e 里模拟崩溃的那一步，以及上游进程自己挂掉），
   * 之后才轮到 close()。此时 direct child 早已 exit，若按 `child.exitCode` 短路
   * 就会整段跳过终止、孙进程留成孤儿；必须按保存下来的 pid/PGID 照样收组。
   *
   * 这条同时覆盖 transport 自发退出的路径：child exit → fireClose → AcpClient
   * handleTransportClose → handleTransportFailure → client.close() → transport.close()。
   */
  it.skipIf(process.platform === 'win32')(
    'close() still reaps the group after the leader was hard-killed',
    async () => {
      const { transport, leaderPid, grandchildPid } = await bootWithGrandchild();
      expect(processAlive(grandchildPid)).toBe(true);

      process.kill(leaderPid, 'SIGKILL');
      await expectDeadWithin(leaderPid, 3000, 'leader');
      // 关键前提：leader 已死，孙进程还活着（正是泄漏现场）。
      expect(processAlive(grandchildPid), 'grandchild should outlive the killed leader').toBe(true);

      await transport.close('test reap after leader hard-kill');

      await expectDeadWithin(grandchildPid, 3000, 'grandchild orphaned after leader hard-kill');
    },
    20_000,
  );

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
