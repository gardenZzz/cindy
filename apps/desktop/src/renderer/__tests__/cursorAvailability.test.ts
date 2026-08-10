/**
 * cursorAvailability —— 「本机装没装 cursor-agent」全局缓存的单测。
 *
 * 锁住四件事(每条对应一个真实故障形态):
 *  1. `peek` 在结果回来前是 null,**不是** false —— 新建页据此区分「未知」与「确认没装」,
 *     判错就会在探测窗口期把停在 cursor 的草稿翻成 cc 且不翻回去;
 *  2. 单飞行 + 缓存:并发/后续调用不重复发 IPC(四个消费点共用这一份);
 *  3. `refresh` 强制重探并通知订阅方(设置页「重新检查」、门禁的否定结果复核);
 *  4. 装完直写(`setCursorAvailability`)不被同期在飞的重探回滚 —— 否则装完那一刻
 *     UI 会闪回「没装」。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  __testing,
  getCursorAvailability,
  peekCursorAvailability,
  setCursorAvailability,
  subscribeCursorAvailability,
} from '@/state/cursorAvailability';

type Probe = () => Promise<{ installed: boolean }>;

function installProbe(probe: Probe): void {
  (globalThis as unknown as { window: unknown }).window = {
    electronAPI: { maker: { agent: { getCursorBinaryStatus: probe } } },
  };
}

/** 手动控制 resolve 时机的探测桩。 */
function deferredProbe() {
  const calls: Array<(installed: boolean) => void> = [];
  const probe = vi.fn<Probe>(
    () => new Promise((resolve) => calls.push((installed) => resolve({ installed }))),
  );
  return { probe, calls };
}

beforeEach(() => {
  __testing.reset();
});

describe('cursorAvailability', () => {
  it('结果回来前 peek 是 null(未知),不得被当成「没装」', async () => {
    const { probe, calls } = deferredProbe();
    installProbe(probe);

    const pending = getCursorAvailability();
    expect(peekCursorAvailability()).toBeNull();

    calls[0](true);
    await expect(pending).resolves.toBe(true);
    expect(peekCursorAvailability()).toBe(true);
  });

  it('并发调用共享同一次探测,解析后走缓存不再发 IPC', async () => {
    const { probe, calls } = deferredProbe();
    installProbe(probe);

    const a = getCursorAvailability();
    const b = getCursorAvailability();
    expect(probe).toHaveBeenCalledTimes(1);

    calls[0](true);
    await Promise.all([a, b]);

    await expect(getCursorAvailability()).resolves.toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('refresh 强制重探并通知订阅方', async () => {
    const { probe, calls } = deferredProbe();
    installProbe(probe);

    const first = getCursorAvailability();
    calls[0](false);
    await first;

    const listener = vi.fn();
    subscribeCursorAvailability(listener);

    const second = getCursorAvailability({ refresh: true });
    expect(probe).toHaveBeenCalledTimes(2);
    calls[1](true);
    await expect(second).resolves.toBe(true);

    expect(peekCursorAvailability()).toBe(true);
    expect(listener).toHaveBeenCalled();
  });

  it('装完直写不被同期在飞的重探回滚', async () => {
    const { probe, calls } = deferredProbe();
    installProbe(probe);

    const inflight = getCursorAvailability({ refresh: true });
    // 安装成功(设置页直写)先落地,随后那次重探才拿到过期的「没装」。
    setCursorAvailability(true);
    calls[0](false);
    await inflight;

    expect(peekCursorAvailability()).toBe(true);
  });

  it('preload 缺失 / 探测抛错一律 false(fail-closed)', async () => {
    (globalThis as unknown as { window: unknown }).window = {};
    await expect(getCursorAvailability()).resolves.toBe(false);

    __testing.reset();
    installProbe(() => Promise.reject(new Error('boom')));
    await expect(getCursorAvailability()).resolves.toBe(false);
  });
});
