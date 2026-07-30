/**
 * cursor-acp-mcp 的 buildCursorAcpMcpServers:
 * 缺 sessionId / bridge 不可用 / collab 关 / token 缺失都降级为空(不注册 ctx);
 * 正常路径注册 session ctx 并按 ACP http 形态下发(?session= + Bearer header),
 * 名单只含协同白名单;cleanup 注销 ctx 且带代际比较。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CodexHttpBridge } from '../../mcp-integrations/codexHttpBridge.js';
import { buildCursorAcpMcpServers } from '../cursor-acp-mcp.js';

function fakeBridge() {
  const registered = new Map<string, unknown>();
  const bridge = {
    registerSessionCtx: vi.fn((sessionId: string, ctx: unknown) => {
      registered.set(sessionId, ctx);
    }),
    unregisterSessionCtx: vi.fn((sessionId: string, expectedCtx?: unknown) => {
      if (expectedCtx !== undefined && registered.get(sessionId) !== expectedCtx) return;
      registered.delete(sessionId);
    }),
  };
  return { bridge: bridge as unknown as CodexHttpBridge, registered, spies: bridge };
}

const STARTED = (bridge: CodexHttpBridge, serverNames = ['cindy_orca', 'orca_worker_bridge', 'cindy_ssh']) =>
  async () => ({ port: 38080, serverNames, bridge });

describe('buildCursorAcpMcpServers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty without a business session id (?session= is the only identity channel)', async () => {
    const { bridge, registered } = fakeBridge();
    const ensureBridgeStarted = vi.fn(STARTED(bridge));
    const out = await buildCursorAcpMcpServers(
      { workingDir: '/repo' },
      { ensureBridgeStarted, getBridgeToken: () => 'tok' },
    );
    expect(out.servers).toEqual([]);
    expect(ensureBridgeStarted).not.toHaveBeenCalled();
    expect(registered.size).toBe(0);
  });

  it('returns empty when the bridge is unavailable', async () => {
    const out = await buildCursorAcpMcpServers(
      { sessionId: 's1', workingDir: '/repo' },
      { ensureBridgeStarted: async () => null },
    );
    expect(out.servers).toEqual([]);
  });

  it('returns empty and registers nothing when collab is globally disabled', async () => {
    const { bridge, registered } = fakeBridge();
    const out = await buildCursorAcpMcpServers(
      { sessionId: 's1', workingDir: '/repo' },
      {
        ensureBridgeStarted: STARTED(bridge),
        getBridgeToken: () => 'tok',
        isCollabEnabled: () => false,
      },
    );
    expect(out.servers).toEqual([]);
    expect(registered.size).toBe(0);
  });

  it('returns empty without registering ctx when the bridge token is unavailable', async () => {
    const { bridge, registered } = fakeBridge();
    const out = await buildCursorAcpMcpServers(
      { sessionId: 's1', workingDir: '/repo' },
      { ensureBridgeStarted: STARTED(bridge), getBridgeToken: () => null },
    );
    expect(out.servers).toEqual([]);
    expect(registered.size).toBe(0);
  });

  it('emits ACP http entries for the collab servers only, with ?session= routing and a bearer header', async () => {
    const { bridge, registered } = fakeBridge();
    const out = await buildCursorAcpMcpServers(
      {
        sessionId: 'w-1',
        workingDir: '/repo',
        vendorOptions: { orcaRole: 'worker', orcaWorkerId: 'worker-1' },
      },
      { ensureBridgeStarted: STARTED(bridge), getBridgeToken: () => 'tok' },
    );
    expect(out.servers.map((s) => s.name)).toEqual(['cindy_orca', 'orca_worker_bridge']);
    expect(out.servers[0]).toEqual({
      type: 'http',
      name: 'cindy_orca',
      url: 'http://127.0.0.1:38080/mcp/cindy_orca?session=w-1',
      headers: [{ name: 'Authorization', value: 'Bearer tok' }],
    });
    // 创建方显式 vendorOptions 优先，不回退 DB 合成（worker 首建时 DB 尚无角色）。
    expect(registered.get('w-1')).toMatchObject({
      agentKind: 'cursor',
      sessionId: 'w-1',
      vendorOptions: { orcaRole: 'worker', orcaWorkerId: 'worker-1' },
    });
  });

  it('falls back to DB-synthesized orca vendorOptions when the caller does not declare them', async () => {
    const { bridge, registered } = fakeBridge();
    await buildCursorAcpMcpServers(
      { sessionId: 'lead-1', workingDir: '/repo' },
      {
        ensureBridgeStarted: STARTED(bridge),
        getBridgeToken: () => 'tok',
        synthesizeVendorOptions: async () => ({ orcaRole: 'lead', orcaLeadSessionId: 'lead-1' }),
      },
    );
    expect(registered.get('lead-1')).toMatchObject({
      vendorOptions: { orcaRole: 'lead', orcaLeadSessionId: 'lead-1' },
    });
  });

  it('cleanup unregisters the ctx it registered and does not clobber a newer generation', async () => {
    const { bridge, registered } = fakeBridge();
    const first = await buildCursorAcpMcpServers(
      { sessionId: 's1', workingDir: '/repo', vendorOptions: { orcaRole: 'worker' } },
      { ensureBridgeStarted: STARTED(bridge), getBridgeToken: () => 'tok' },
    );
    // 同 session 重建（resume）覆盖注册。
    await buildCursorAcpMcpServers(
      { sessionId: 's1', workingDir: '/repo', vendorOptions: { orcaRole: 'worker' } },
      { ensureBridgeStarted: STARTED(bridge), getBridgeToken: () => 'tok' },
    );
    // 旧代际迟到的 cleanup 不得删掉新 ctx。
    first.cleanup?.();
    expect(registered.size).toBe(1);
  });
});
