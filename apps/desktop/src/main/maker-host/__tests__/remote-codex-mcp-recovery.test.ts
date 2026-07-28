/**
 * remote-codex-mcp-recovery 测试:bridge 重建后的恢复遍历 — host 过滤、
 * checker 未装配不触发、ensure 参数、失败记 warn。
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { RemoteHost } from '@cindy/maker-remote-ssh';

vi.mock('../../remote-ssh/codex-remote-mcp.js', () => ({
  ensureRemoteCodexMcpBridge: vi.fn(async () => ({ ok: true })),
}));

import { refreshRemoteCodexMcpAfterBridgeRecreate } from '../remote-codex-mcp-recovery.js';
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
