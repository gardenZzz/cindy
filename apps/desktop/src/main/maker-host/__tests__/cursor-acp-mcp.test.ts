/**
 * cursor-acp-mcp 的 buildCursorAcpMcpServers:
 * 缺 sessionId / bridge 不可用 / 无可用 server / token 缺失都降级为空(不注册 ctx);
 * 正常路径注册 session ctx 并按 ACP http 形态下发(?session= + Bearer header);
 * 注入 bridge 全量已启用 server（collab 关时剥协同两件套）；默认主 token 全通;
 * 主 token 必须同时 registerSessionToken（bridge 对 ?session= 的 TOCTOU 收口）;
 * cleanup 成对注销 ctx + token 且带代际比较。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CodexHttpBridge } from '../../mcp-integrations/codexHttpBridge.js';
import {
  buildCursorAcpMcpServers,
  selectCursorInjectableServerNames,
} from '../cursor-acp-mcp.js';

function fakeBridge(token = 'primary-tok') {
  const registered = new Map<string, unknown>();
  const tokens = new Map<string, { token: string; generation: number }>();
  let nextGeneration = 0;
  const bridge = {
    token,
    registerSessionCtx: vi.fn((sessionId: string, ctx: unknown) => {
      registered.set(sessionId, ctx);
    }),
    unregisterSessionCtx: vi.fn((sessionId: string, expectedCtx?: unknown) => {
      if (expectedCtx !== undefined && registered.get(sessionId) !== expectedCtx) return;
      registered.delete(sessionId);
    }),
    registerSessionToken: vi.fn((sessionId: string, sessionToken: string) => {
      const generation = nextGeneration++;
      tokens.set(sessionId, { token: sessionToken, generation });
      return generation;
    }),
    unregisterSessionToken: vi.fn(
      (sessionId: string, expectedToken?: string, generation?: number) => {
        const entry = tokens.get(sessionId);
        if (entry === undefined) return;
        if (expectedToken !== undefined && entry.token !== expectedToken) return;
        if (generation !== undefined && entry.generation !== generation) return;
        tokens.delete(sessionId);
      },
    ),
  };
  return { bridge: bridge as unknown as CodexHttpBridge, registered, tokens, spies: bridge };
}

const STARTED = (
  bridge: CodexHttpBridge,
  serverNames = ['cindy_orca', 'orca_worker_bridge', 'cindy_browser', 'cindy_ssh'],
) => async () => ({ port: 38080, serverNames, bridge });

describe('selectCursorInjectableServerNames', () => {
  it('keeps the full snapshot when collab is enabled', () => {
    expect(
      selectCursorInjectableServerNames(
        ['cindy_orca', 'cindy_browser', 'cindy_ssh'],
        { collabEnabled: true },
      ),
    ).toEqual(['cindy_orca', 'cindy_browser', 'cindy_ssh']);
  });

  it('strips collab servers when collab is disabled', () => {
    expect(
      selectCursorInjectableServerNames(
        ['cindy_orca', 'orca_worker_bridge', 'cindy_browser', 'cindy_ssh'],
        { collabEnabled: false },
      ),
    ).toEqual(['cindy_browser', 'cindy_ssh']);
  });

  it('strips project-disabled plugins while keeping others', () => {
    expect(
      selectCursorInjectableServerNames(
        ['cindy_orca', 'cindy_browser', 'cindy_ssh', 'cindy_scheduler'],
        { collabEnabled: true, disabledPluginIds: ['browser', 'ssh'] },
      ),
    ).toEqual(['cindy_orca', 'cindy_scheduler']);
  });
});

describe('buildCursorAcpMcpServers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty without a business session id (?session= is the only identity channel)', async () => {
    const { bridge, registered } = fakeBridge();
    const ensureBridgeStarted = vi.fn(STARTED(bridge));
    const out = await buildCursorAcpMcpServers(
      { workingDir: '/repo' },
      { ensureBridgeStarted },
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

  it('strips collab servers when collab is globally disabled but keeps other lizi MCPs', async () => {
    const { bridge, registered } = fakeBridge();
    const out = await buildCursorAcpMcpServers(
      { sessionId: 's1', workingDir: '/repo' },
      {
        ensureBridgeStarted: STARTED(bridge),
        isCollabEnabled: () => false,
      },
    );
    expect(out.servers.map((s) => s.name)).toEqual(['cindy_browser', 'cindy_ssh']);
    expect(registered.size).toBe(1);
  });

  it('returns empty without registering ctx when an injected token override is null', async () => {
    const { bridge, registered, spies } = fakeBridge();
    const out = await buildCursorAcpMcpServers(
      { sessionId: 's1', workingDir: '/repo' },
      { ensureBridgeStarted: STARTED(bridge), getBridgeToken: () => null },
    );
    expect(out.servers).toEqual([]);
    expect(registered.size).toBe(0);
    expect(spies.registerSessionToken).not.toHaveBeenCalled();
  });

  it('emits ACP http entries for all enabled bridge servers with primary token by default', async () => {
    const { bridge, registered, spies } = fakeBridge('primary-tok');
    const out = await buildCursorAcpMcpServers(
      {
        sessionId: 'w-1',
        workingDir: '/repo',
        vendorOptions: { orcaRole: 'worker', orcaWorkerId: 'worker-1' },
      },
      { ensureBridgeStarted: STARTED(bridge) },
    );
    expect(out.servers.map((s) => s.name)).toEqual([
      'cindy_orca',
      'orca_worker_bridge',
      'cindy_browser',
      'cindy_ssh',
    ]);
    expect(out.servers[0]).toEqual({
      type: 'http',
      name: 'cindy_orca',
      url: 'http://127.0.0.1:38080/mcp/cindy_orca?session=w-1',
      headers: [{ name: 'Authorization', value: 'Bearer primary-tok' }],
    });
    // 创建方显式 vendorOptions 优先，不回退 DB 合成（worker 首建时 DB 尚无角色）。
    expect(registered.get('w-1')).toMatchObject({
      agentKind: 'cursor',
      sessionId: 'w-1',
      vendorOptions: {
        orcaRole: 'worker',
        orcaWorkerId: 'worker-1',
        __cindyDisabledBuiltinPluginIds: [],
      },
    });
    expect(spies.registerSessionToken).toHaveBeenCalledWith('w-1', 'primary-tok');
  });

  it('stamps root caller provenance so worker bridge tools are not fail-closed', async () => {
    const { bridge, registered } = fakeBridge();
    await buildCursorAcpMcpServers(
      {
        sessionId: 'w-1',
        workingDir: '/repo',
        vendorOptions: { orcaRole: 'worker', orcaWorkerId: 'worker-1' },
      },
      { ensureBridgeStarted: STARTED(bridge) },
    );
    // Cursor 无 per-call root/descendant 信号（subagent 与主循环共用同一条 MCP
    // 连接），只能无条件盖 root；漏盖会让 send_to_lead 恒回
    // CALLER_PROVENANCE_REQUIRED。
    expect(registered.get('w-1')).toMatchObject({
      mcpCallerKind: 'root',
      mcpCallerAttested: true,
    });
  });

  it('filters project-disabled servers and freezes disabled snapshot on ctx', async () => {
    const { bridge, registered } = fakeBridge();
    const out = await buildCursorAcpMcpServers(
      { sessionId: 's-disabled', workingDir: '/proj' },
      {
        ensureBridgeStarted: STARTED(bridge),
        getDisabledRuntimePluginIds: () => ['browser', 'ssh'],
      },
    );
    expect(out.servers.map((s) => s.name)).toEqual(['cindy_orca', 'orca_worker_bridge']);
    expect(registered.get('s-disabled')).toMatchObject({
      vendorOptions: {
        __cindyDisabledBuiltinPluginIds: ['browser', 'ssh'],
      },
    });
  });

  it('falls back to DB-synthesized orca vendorOptions when the caller does not declare them', async () => {
    const { bridge, registered } = fakeBridge();
    await buildCursorAcpMcpServers(
      { sessionId: 'lead-1', workingDir: '/repo' },
      {
        ensureBridgeStarted: STARTED(bridge),
        synthesizeVendorOptions: async () => ({ orcaRole: 'lead', orcaLeadSessionId: 'lead-1' }),
      },
    );
    expect(registered.get('lead-1')).toMatchObject({
      vendorOptions: { orcaRole: 'lead', orcaLeadSessionId: 'lead-1' },
    });
  });

  it('cleanup unregisters the ctx it registered and does not clobber a newer generation', async () => {
    const { bridge, registered, tokens } = fakeBridge();
    const first = await buildCursorAcpMcpServers(
      { sessionId: 's1', workingDir: '/repo', vendorOptions: { orcaRole: 'worker' } },
      { ensureBridgeStarted: STARTED(bridge) },
    );
    // 同 session 重建（resume）覆盖注册。
    await buildCursorAcpMcpServers(
      { sessionId: 's1', workingDir: '/repo', vendorOptions: { orcaRole: 'worker' } },
      { ensureBridgeStarted: STARTED(bridge) },
    );
    // 旧代际迟到的 cleanup 不得删掉新 ctx。
    first.cleanup?.();
    expect(registered.size).toBe(1);
    expect(tokens.size).toBe(1);
  });
});
