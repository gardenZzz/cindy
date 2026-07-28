/**
 * remote-codex-mcp-recovery 测试:bridge 重建后的恢复遍历 — host 过滤、
 * checker 未装配不触发、ensure 参数、失败记 warn。
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { RemoteHost } from '@cindy/maker-remote-ssh';

vi.mock('../../remote-ssh/codex-remote-mcp.js', () => ({
  ensureRemoteCodexMcpBridge: vi.fn(async () => ({ ok: true })),
}));

import {
  refreshRemoteCodexMcpAfterBridgeRecreate,
  invalidateRemoteCcQueriesForMcpGenerationChange,
  maybeDetachStaleRemoteCcQuery,
} from '../remote-codex-mcp-recovery.js';
import { ensureRemoteCodexMcpBridge } from '../../remote-ssh/codex-remote-mcp.js';

const ensureMock = vi.mocked(ensureRemoteCodexMcpBridge);

function host(id: string): RemoteHost {
  return { id } as unknown as RemoteHost;
}

function makeDeps(overrides?: Partial<Parameters<typeof refreshRemoteCodexMcpAfterBridgeRecreate>[0]>) {
  const warn = vi.fn();
  const checker = (_hostId: string): boolean => false;
  const deps = {
    listRemoteCodexHostIds: () => ['host-a', 'host-b'],
    getReadyHost: (id: string) => host(id),
    ensureBridgeStarted: async () => ({ port: 38080, serverNames: ['cindy_orca'], bridgeInstanceId: 'bridge-2' }),
    getLiveTurnChecker: () => checker,
    isCollabEnabled: () => true,
    log: { warn },
    ...overrides,
  };
  return { deps, warn, checker };
}

describe('refreshRemoteCodexMcpAfterBridgeRecreate', () => {
  beforeEach(() => {
    ensureMock.mockClear();
    ensureMock.mockResolvedValue({ ok: true });
  });

  it('ensures every active remote codex host with the shared live-turn checker', () => {
    const { deps, checker } = makeDeps();
    refreshRemoteCodexMcpAfterBridgeRecreate(deps);
    expect(ensureMock).toHaveBeenCalledTimes(2);
    for (const [callHost, callDeps] of ensureMock.mock.calls) {
      expect(['host-a', 'host-b']).toContain(callHost.id);
      expect(callDeps.ensureBridgeStarted).toBe(deps.ensureBridgeStarted);
      expect(callDeps.hasLiveTurnOnHost).toBe(checker);
      // R21 P1: 恢复路径必须透传 Collab 闸门 — 禁用时 ensure 走清理而非重注入。
      expect(callDeps.isCollabEnabled).toBe(deps.isCollabEnabled);
    }
  });

  it('skips hosts that are not ready', () => {
    const { deps } = makeDeps({
      getReadyHost: (id) => (id === 'host-a' ? host(id) : null),
    });
    refreshRemoteCodexMcpAfterBridgeRecreate(deps);
    expect(ensureMock).toHaveBeenCalledTimes(1);
    expect(ensureMock.mock.calls[0][0].id).toBe('host-a');
  });

  it('does nothing when the live-turn checker is not wired (never kills a turn by mistake)', () => {
    const { deps } = makeDeps({ getLiveTurnChecker: () => null });
    refreshRemoteCodexMcpAfterBridgeRecreate(deps);
    expect(ensureMock).not.toHaveBeenCalled();
  });

  it('logs a warning instead of throwing when an ensure reports failure', async () => {
    ensureMock.mockResolvedValue({ ok: false, reason: 'forward-failed' });
    const { deps, warn } = makeDeps({ listRemoteCodexHostIds: () => ['host-a'] });
    refreshRemoteCodexMcpAfterBridgeRecreate(deps);
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(
        'remote MCP recovery after bridge recreate failed',
        expect.objectContaining({ hostId: 'host-a', reason: 'forward-failed' }),
      );
    });
  });
});

describe('invalidateRemoteCcQueriesForMcpGenerationChange', () => {
  function ccSession(id: string, remoteHostId: string | null, running = false) {
    return {
      id,
      remoteHostId,
      isTurnRunning: () => running,
      detach: vi.fn(async () => {}),
    };
  }

  it('clears fresh marks and detaches idle remote CC queries; skips running turns without detaching', () => {
    const idle = ccSession('cc-1', 'host-a');
    const running = ccSession('cc-2', 'host-a', true);
    const local = ccSession('cc-3', null);
    const cleared: string[] = [];
    invalidateRemoteCcQueriesForMcpGenerationChange(
      {
        listRemoteCcSessions: () => [idle, running, local],
        clearFreshMark: (id) => cleared.push(id),
        log: { warn: vi.fn() },
      },
      { reason: 'bridge-recreate' },
    );
    expect(cleared).toEqual(['cc-1', 'cc-2']);
    expect(idle.detach).toHaveBeenCalledTimes(1);
    expect(running.detach).not.toHaveBeenCalled();
    expect(local.detach).not.toHaveBeenCalled();
  });

  it('scopes invalidation to the given hostId (forward rearm affects one host)', () => {
    const onA = ccSession('cc-1', 'host-a');
    const onB = ccSession('cc-2', 'host-b');
    const cleared: string[] = [];
    invalidateRemoteCcQueriesForMcpGenerationChange(
      {
        listRemoteCcSessions: () => [onA, onB],
        clearFreshMark: (id) => cleared.push(id),
        log: { warn: vi.fn() },
      },
      { hostId: 'host-a', reason: 'forward-rearmed' },
    );
    expect(cleared).toEqual(['cc-1']);
    expect(onA.detach).toHaveBeenCalledTimes(1);
    expect(onB.detach).not.toHaveBeenCalled();
  });
});

describe('maybeDetachStaleRemoteCcQuery', () => {
  it('detaches when the fresh mark is gone and no turn is running', () => {
    const s = { id: 'cc-1', remoteHostId: 'host-a', isTurnRunning: () => false, detach: vi.fn(async () => {}) };
    maybeDetachStaleRemoteCcQuery(
      { getSession: () => s, hasFreshMark: () => false, log: { warn: vi.fn() } },
      'cc-1',
    );
    expect(s.detach).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when the fresh mark is still valid or the session is local or a turn is running', () => {
    const fresh = { id: 'cc-1', remoteHostId: 'host-a', isTurnRunning: () => false, detach: vi.fn(async () => {}) };
    maybeDetachStaleRemoteCcQuery(
      { getSession: () => fresh, hasFreshMark: () => true, log: { warn: vi.fn() } },
      'cc-1',
    );
    expect(fresh.detach).not.toHaveBeenCalled();

    const local = { id: 'cc-2', remoteHostId: null, isTurnRunning: () => false, detach: vi.fn(async () => {}) };
    maybeDetachStaleRemoteCcQuery(
      { getSession: () => local, hasFreshMark: () => false, log: { warn: vi.fn() } },
      'cc-2',
    );
    expect(local.detach).not.toHaveBeenCalled();

    const running = { id: 'cc-3', remoteHostId: 'host-a', isTurnRunning: () => true, detach: vi.fn(async () => {}) };
    maybeDetachStaleRemoteCcQuery(
      { getSession: () => running, hasFreshMark: () => false, log: { warn: vi.fn() } },
      'cc-3',
    );
    expect(running.detach).not.toHaveBeenCalled();
  });
});
