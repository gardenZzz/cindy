/**
 * StdioTransport close 必须真正杀掉子进程，避免 PPID=1 孤儿。
 */

import { describe, expect, it } from 'vitest';
import process from 'node:process';

import {
  createAcpStdioTransport,
  killWindowsTree,
  type TaskkillHandle,
} from './stdioTransport.js';

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

  /**
   * Windows 分支在开发机 (macOS) 与 CI (ubuntu-latest) 上都跑不到，只能注入
   * spawner 验证。关键是 'exit' 非零那条：Node 的 'error' **只**表示 taskkill
   * 自身起不来 (ENOENT)，而访问被拒 / 进程表竞态是正常启动后返回非零，只走
   * 'exit' —— 只听 error 会让 close() 伪成功、ACP 树残留。
   */
  describe('killWindowsTree fallback', () => {
    interface FakeKiller extends TaskkillHandle {
      fire(event: 'error' | 'exit', code?: number | null): void;
    }

    function fakeKiller(): FakeKiller {
      const listeners = new Map<string, Array<(code?: number | null) => void>>();
      return {
        on(event: 'error' | 'exit', listener: (code?: number | null) => void): unknown {
          const bucket = listeners.get(event) ?? [];
          bucket.push(listener);
          listeners.set(event, bucket);
          return this;
        },
        fire(event: 'error' | 'exit', code?: number | null): void {
          for (const l of listeners.get(event) ?? []) l(code);
        },
      };
    }

    it('falls back to child.kill when taskkill exits non-zero', () => {
      const killer = fakeKiller();
      const killed: NodeJS.Signals[] = [];
      killWindowsTree(1234, 'SIGTERM', (s) => killed.push(s), () => killer);

      expect(killed, 'must not fall back before taskkill settles').toEqual([]);
      killer.fire('exit', 1);
      expect(killed, 'non-zero taskkill exit must trigger fallback').toEqual(['SIGTERM']);
    });

    it('falls back when taskkill itself cannot spawn', () => {
      const killer = fakeKiller();
      const killed: NodeJS.Signals[] = [];
      killWindowsTree(1234, 'SIGKILL', (s) => killed.push(s), () => killer);
      killer.fire('error');
      expect(killed).toEqual(['SIGKILL']);
    });

    it('falls back when the spawner throws synchronously', () => {
      const killed: NodeJS.Signals[] = [];
      killWindowsTree(1234, 'SIGTERM', (s) => killed.push(s), () => {
        throw new Error('EACCES');
      });
      expect(killed).toEqual(['SIGTERM']);
    });

    it('does not fall back when taskkill succeeds, and never falls back twice', () => {
      const killer = fakeKiller();
      const killed: NodeJS.Signals[] = [];
      killWindowsTree(1234, 'SIGTERM', (s) => killed.push(s), () => killer);

      killer.fire('exit', 0);
      expect(killed, 'exit 0 means the tree is gone').toEqual([]);

      // 幂等：即便再来一次失败事件也只回落一次。
      killer.fire('error');
      killer.fire('exit', 1);
      expect(killed).toEqual(['SIGTERM']);
    });
  });

  /**
   * transport 级（而非直接调 helper）：helper 单次调用内只 spawn 一次是不够的，
   * close() 若沿用 POSIX 的 TERM→wait→KILL 两段，Windows 上第一次就已发出带 /F
   * 的 taskkill，grace 内 direct child 未 exit 时会再 spawn 第二个，与前一个并发
   * 操作同一 PID 树。上面那组 helper 用例完全绕过了这段时序，锁不住。
   */
  it('close() spawns taskkill exactly once on Windows, even if it never settles', async () => {
    let spawnCount = 0;
    const transport = createAcpStdioTransport({
      binaryPath: process.execPath,
      // 子进程故意不退出：制造「grace 跨过但 direct child 仍活」的窗口。
      args: ['-e', 'setInterval(()=>{},1000)'],
      sigtermGraceMs: 60,
      sigkillWaitMs: 60,
      platformOverride: 'win32',
      // taskkill 永不发终态（不 exit、不 error）——最坏情况。
      taskkillSpawner: () => {
        spawnCount += 1;
        return { on: () => undefined };
      },
    });

    const pid = transport.getPid?.() as number;
    await transport.close('test windows single taskkill');

    expect(spawnCount, 'Windows close() must issue exactly one taskkill').toBe(1);

    // 兜底清掉这个真实子进程：win32 分支下 killTree 走的是假 spawner，没人真杀它。
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }, 20_000);

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
