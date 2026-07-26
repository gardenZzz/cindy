/**
 * remoteProjectsStore — vitest 单测(push 驱动纯镜像)
 *
 * 覆盖 device-link 控制端内存层的核心不变量:
 *  - setDeviceSessions:打 device-link origin 标记 + 合并扁平列表 + sessionId→deviceId 注册 + 引用稳定
 *  - applyPatch:就地幂等合并 / status=deleted|archived 移出分片 / 落到未知 session 丢弃
 *  - epoch:旧 snapshot 不覆盖新 snapshot(乱序保护)
 *  - markDeviceDisconnected:断线保留快照 + 在线索引清理;removeDevice / clear:明确移除时清理
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  remoteProjectsStore,
  getSessionDeviceId,
  setRemoteReseedImpl,
} from '@/features/device-link/remoteProjectsStore';
import type { Session } from '@/lib/ccAgent.types';

/** 造一个最小可用 Session(store 只存/透传,不校验字段)。 */
function mk(id: string, partial: Partial<Session> = {}): Session {
  return {
    id,
    userId: 'u',
    title: partial.title ?? id,
    workingDir: partial.workingDir ?? `/proj/${id}`,
    workspaceKind: 'project',
    model: partial.model ?? 'gpt-5.4',
    effort: (partial.effort ?? 'medium') as Session['effort'],
    permissionMode: (partial.permissionMode ?? 'default') as Session['permissionMode'],
    sdkSessionId: null,
    totalTokenUsage: 0,
    totalCostUsd: 0,
    contextTokens: 0,
    contextWindow: 0,
    fastMode: partial.fastMode ?? false,
    clearedAt: null,
    pinnedAt: partial.pinnedAt ?? null,
    userSendAt: '2026-01-01T00:00:00.000Z',
    status: partial.status ?? 'active',
    agentKind: partial.agentKind ?? 'cc',
    extraDirs: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('remoteProjectsStore', () => {
  beforeEach(() => {
    setRemoteReseedImpl(null);
    remoteProjectsStore.clear();
  });

  it('stamps device-link origin, merges sessions, and registers sessionId→deviceId', () => {
    remoteProjectsStore.setDeviceSessions('dev-B', 'Bob Mac', [mk('s1'), mk('s2')]);
    const merged = remoteProjectsStore.getMergedRemoteSessions();
    expect(merged).toHaveLength(2);
    for (const s of merged) {
      expect(s.deviceLinkDeviceId).toBe('dev-B');
      expect(s.deviceLinkDeviceName).toBe('Bob Mac');
      expect(s.deviceLinkConnectionStatus).toBe('connected');
    }
    expect(getSessionDeviceId('s1')).toBe('dev-B');
    expect(getSessionDeviceId('unknown')).toBeUndefined();
  });

  it('merges multiple devices and keeps origin per device', () => {
    remoteProjectsStore.setDeviceSessions('dev-B', 'B', [mk('s1')]);
    remoteProjectsStore.setDeviceSessions('dev-C', 'C', [mk('s2')]);
    expect(remoteProjectsStore.getMergedRemoteSessions()).toHaveLength(2);
    expect(getSessionDeviceId('s1')).toBe('dev-B');
    expect(getSessionDeviceId('s2')).toBe('dev-C');
  });

  it('snapshot reference is stable across no-op (useSyncExternalStore safety)', () => {
    remoteProjectsStore.setDeviceSessions('dev-B', 'B', [mk('s1')]);
    const a = remoteProjectsStore.getMergedRemoteSessions();
    const b = remoteProjectsStore.getMergedRemoteSessions();
    expect(a).toBe(b);
  });

  describe('applyPatch(push 驱动镜像)', () => {
    it('就地幂等合并字段(title / pinnedAt / model)', () => {
      remoteProjectsStore.setDeviceSessions('dev-B', 'B', [mk('s1', { model: 'gpt-5.4' })]);
      remoteProjectsStore.applyPatch('dev-B', 's1', { title: 'New', model: 'opus-4-8' });
      const s = remoteProjectsStore.getMergedRemoteSessions().find((x) => x.id === 's1')!;
      expect(s.title).toBe('New');
      expect(s.model).toBe('opus-4-8');
      expect(getSessionDeviceId('s1')).toBe('dev-B'); // origin 标记不丢
    });

    it('status=deleted / archived → 移出分片', () => {
      remoteProjectsStore.setDeviceSessions('dev-B', 'B', [mk('s1'), mk('s2')]);
      remoteProjectsStore.applyPatch('dev-B', 's1', { status: 'deleted' });
      expect(remoteProjectsStore.getMergedRemoteSessions().map((x) => x.id)).toEqual(['s2']);
      remoteProjectsStore.applyPatch('dev-B', 's2', { status: 'archived' });
      expect(remoteProjectsStore.getMergedRemoteSessions()).toHaveLength(0);
      expect(getSessionDeviceId('s1')).toBeUndefined();
    });

    it('unpin 后触发 reseed,让仅因 includePinned 补入的旧会话被后续 snapshot 剔除', () => {
      const reseed = vi.fn();
      setRemoteReseedImpl(reseed);
      remoteProjectsStore.setDeviceSessions('dev-B', 'B', [
        mk('old-pinned', { pinnedAt: '2026-01-02T00:00:00.000Z' }),
      ]);

      remoteProjectsStore.applyPatch('dev-B', 'old-pinned', { pinnedAt: null });

      expect(remoteProjectsStore.getMergedRemoteSessions()[0].pinnedAt).toBeNull();
      expect(reseed).toHaveBeenCalledWith('dev-B');
      expect(reseed).toHaveBeenCalledTimes(1);
    });

    it('落到未知 session 丢弃(不造壳)', () => {
      remoteProjectsStore.setDeviceSessions('dev-B', 'B', [mk('s1')]);
      remoteProjectsStore.applyPatch('dev-B', 'ghost', { title: 'X' });
      expect(remoteProjectsStore.getMergedRemoteSessions().map((x) => x.id)).toEqual(['s1']);
    });

    it('未知设备 no-op', () => {
      remoteProjectsStore.applyPatch('dev-Z', 's1', { title: 'X' });
      expect(remoteProjectsStore.getMergedRemoteSessions()).toHaveLength(0);
    });
  });

  describe('snapshot epoch(乱序保护)', () => {
    it('旧 snapshot 不覆盖新 snapshot', () => {
      remoteProjectsStore.setDeviceSessions('dev-B', 'B', [mk('s1', { model: 'old' })]);
      // 模拟两次重拉:先发起 e1(旧),再发起 e2(新);e2 先 set,e1 后到应被丢弃。
      const e1 = remoteProjectsStore.nextSnapshotEpoch('dev-B');
      const e2 = remoteProjectsStore.nextSnapshotEpoch('dev-B');
      expect(remoteProjectsStore.isLatestSnapshotEpoch('dev-B', e2)).toBe(true);
      // e2 的结果落地
      if (remoteProjectsStore.isLatestSnapshotEpoch('dev-B', e2)) {
        remoteProjectsStore.setDeviceSessions('dev-B', 'B', [mk('s1', { model: 'new' })]);
      }
      // e1(旧)回来:已非最新 → 调用方据 isLatestSnapshotEpoch 丢弃,不 set
      expect(remoteProjectsStore.isLatestSnapshotEpoch('dev-B', e1)).toBe(false);
      const s = remoteProjectsStore.getMergedRemoteSessions().find((x) => x.id === 's1')!;
      expect(s.model).toBe('new');
    });

    it('removeDevice 即使无 shard 也失效 epoch:在途 refresh 不会把已移除设备会话加回', () => {
      // 设备首次 bootstrap 还没建 shard 就被移除(下线/关被控),此刻在途 refresh 已取 epoch。
      const e = remoteProjectsStore.nextSnapshotEpoch('dev-X'); // 无 shard
      remoteProjectsStore.removeDevice('dev-X');
      // 在途 refresh await 回来:epoch 已失效 → isLatestSnapshotEpoch=false → 调用方丢弃结果。
      expect(remoteProjectsStore.isLatestSnapshotEpoch('dev-X', e)).toBe(false);
    });

    it('clear() 即使无 shard 也清 epoch:断连时在途首拉不会把会话加回', () => {
      // relay 断连(connecting/stopped)调 clear();某设备首拉还在途、shard 未建,此刻已取 epoch。
      const e = remoteProjectsStore.nextSnapshotEpoch('dev-Y'); // 无 shard
      remoteProjectsStore.clear();
      // 在途首拉 await 回来:epoch 已被 clear 失效 → 调用方据 isLatestSnapshotEpoch 丢弃,不 set。
      expect(remoteProjectsStore.isLatestSnapshotEpoch('dev-Y', e)).toBe(false);
    });

    it('[ABA] removeDevice 后重新 bootstrap 的 epoch 不复用旧值,断连前的在途响应永久失效', () => {
      const e1 = remoteProjectsStore.nextSnapshotEpoch('dev-A'); // 断连前在途
      remoteProjectsStore.removeDevice('dev-A'); // 移除 → 自增(非归零)
      const e2 = remoteProjectsStore.nextSnapshotEpoch('dev-A'); // reconnect 后新一轮
      expect(e2).not.toBe(e1); // 关键:不复用 → 无 ABA
      expect(e2).toBeGreaterThan(e1);
      // 断连前在途响应(e1)即使在新一轮发起后回来,也已永久失效,不会盖回新 snapshot。
      expect(remoteProjectsStore.isLatestSnapshotEpoch('dev-A', e1)).toBe(false);
      expect(remoteProjectsStore.isLatestSnapshotEpoch('dev-A', e2)).toBe(true);
    });

    it('[ABA] clear() 后重新 bootstrap 的 epoch 不复用旧值', () => {
      const e1 = remoteProjectsStore.nextSnapshotEpoch('dev-A');
      remoteProjectsStore.clear(); // 断连 → 全部自增(非 clear-to-0)
      const e2 = remoteProjectsStore.nextSnapshotEpoch('dev-A');
      expect(e2).not.toBe(e1);
      expect(e2).toBeGreaterThan(e1);
      expect(remoteProjectsStore.isLatestSnapshotEpoch('dev-A', e1)).toBe(false);
    });
  });

  it('removeDevice clears shard + registry', () => {
    remoteProjectsStore.setDeviceSessions('dev-B', 'B', [mk('s1')]);
    remoteProjectsStore.removeDevice('dev-B');
    expect(remoteProjectsStore.getMergedRemoteSessions()).toHaveLength(0);
    expect(getSessionDeviceId('s1')).toBeUndefined();
    expect(remoteProjectsStore.getDeviceIds()).toHaveLength(0);
  });

  it('markDeviceDisconnected keeps sessions visible but removes the device from the online index', () => {
    remoteProjectsStore.setDeviceSessions('dev-B', 'B', [mk('s1'), mk('s2')]);
    remoteProjectsStore.markDeviceDisconnected('dev-B');

    const merged = remoteProjectsStore.getMergedRemoteSessions();
    expect(merged.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(merged.every((s) => s.deviceLinkConnectionStatus === 'disconnected')).toBe(true);
    // origin 保留:打开会话仍知道要走哪个 device-link 隧道,连接状态由 banner / invoke 错误处理。
    expect(getSessionDeviceId('s1')).toBe('dev-B');
    // 在线索引清掉:useRemoteSessionConnection 会显示 host-offline。
    expect(remoteProjectsStore.getDeviceIds()).toEqual([]);
    expect(remoteProjectsStore.getDeviceList()).toEqual([
      { deviceId: 'dev-B', deviceName: 'B', sessionCount: 2, connected: false },
    ]);
  });

  it('setDeviceSessions reconnects a disconnected cached shard', () => {
    remoteProjectsStore.setDeviceSessions('dev-B', 'B', [mk('s1')]);
    remoteProjectsStore.markDeviceDisconnected('dev-B');
    remoteProjectsStore.setDeviceSessions('dev-B', 'B', [mk('s1')]);

    expect(remoteProjectsStore.getMergedRemoteSessions()[0].deviceLinkConnectionStatus).toBe('connected');
    expect(remoteProjectsStore.getDeviceIds()).toEqual(['dev-B']);
    expect(remoteProjectsStore.getDeviceList()).toEqual([
      { deviceId: 'dev-B', deviceName: 'B', sessionCount: 1, connected: true },
    ]);
  });

  it('tracks terminal bootstrap failures with stable snapshots and clears them after a successful snapshot', () => {
    const before = remoteProjectsStore.getBootstrapFailedDeviceIds();
    remoteProjectsStore.markBootstrapFailed('dev-B');
    const failed = remoteProjectsStore.getBootstrapFailedDeviceIds();
    expect(failed).not.toBe(before);
    expect([...failed]).toEqual(['dev-B']);

    remoteProjectsStore.markBootstrapFailed('dev-B');
    expect(remoteProjectsStore.getBootstrapFailedDeviceIds()).toBe(failed);

    remoteProjectsStore.setDeviceSessions('dev-B', 'B', []);
    expect(remoteProjectsStore.getBootstrapFailedDeviceIds().size).toBe(0);
  });

  it('removeDevice and clear discard bootstrap failure state even before a shard exists', () => {
    remoteProjectsStore.markBootstrapFailed('dev-A');
    remoteProjectsStore.removeDevice('dev-A');
    expect(remoteProjectsStore.getBootstrapFailedDeviceIds().size).toBe(0);

    remoteProjectsStore.markBootstrapFailed('dev-A');
    remoteProjectsStore.markBootstrapFailed('dev-B');
    remoteProjectsStore.clear();
    expect(remoteProjectsStore.getBootstrapFailedDeviceIds().size).toBe(0);
  });

  it('clear resets everything', () => {
    remoteProjectsStore.setDeviceSessions('dev-B', 'B', [mk('s1'), mk('s2')]);
    remoteProjectsStore.clear();
    expect(remoteProjectsStore.getMergedRemoteSessions()).toHaveLength(0);
    expect(getSessionDeviceId('s1')).toBeUndefined();
    expect(remoteProjectsStore.getDeviceIds()).toHaveLength(0);
  });

  it('applyPatch 只换被 patch 设备的会话对象引用,其它设备会话引用稳定(防级联重渲染)', () => {
    remoteProjectsStore.setDeviceSessions('dev-A', 'A', [mk('a1'), mk('a2')]);
    remoteProjectsStore.setDeviceSessions('dev-B', 'B', [mk('b1')]);
    const before = remoteProjectsStore.getMergedRemoteSessions();
    const a1Before = before.find((x) => x.id === 'a1')!;
    const a2Before = before.find((x) => x.id === 'a2')!;

    remoteProjectsStore.applyPatch('dev-B', 'b1', { title: 'B1!' });

    const after = remoteProjectsStore.getMergedRemoteSessions();
    expect(after).not.toBe(before); // 扁平快照 recompute 换新数组
    // dev-A 的会话对象引用未变(只有 dev-B 分片被 .map);否则 React 会无谓重渲所有设备项。
    expect(after.find((x) => x.id === 'a1')).toBe(a1Before);
    expect(after.find((x) => x.id === 'a2')).toBe(a2Before);
    // 被 patch 的 dev-B 会话是新对象 + 新值。
    expect(after.find((x) => x.id === 'b1')!.title).toBe('B1!');
  });

  it('renameDevice:重打 deviceLinkDeviceName + 通知 subscribeRename;同名时不重算(引用稳定)', () => {
    remoteProjectsStore.setDeviceSessions('dev-B', 'Old', [mk('s1')]);
    const seen: Array<[string, string]> = [];
    const off = remoteProjectsStore.subscribeRename((id, name) => seen.push([id, name]));

    remoteProjectsStore.renameDevice('dev-B', 'New');
    expect(
      remoteProjectsStore.getMergedRemoteSessions().find((x) => x.id === 's1')!.deviceLinkDeviceName,
    ).toBe('New');
    expect(seen).toEqual([['dev-B', 'New']]);

    // 同名:分片名未变 → 不 recompute(扁平快照引用不变),避免无谓重渲。
    const beforeSameName = remoteProjectsStore.getMergedRemoteSessions();
    remoteProjectsStore.renameDevice('dev-B', 'New');
    expect(remoteProjectsStore.getMergedRemoteSessions()).toBe(beforeSameName);
    off();
  });
});
