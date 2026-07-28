/**
 * remote-codex-mcp-recovery — bridge 重建后的远端 codex MCP 恢复遍历。
 *
 * 背景 (codex-connector R18 P1):custom MCP CRUD / 全局插件开关会 shutdown
 * codexHttpBridge 并 lazy 重建 (新端口 / 新 instanceId)。remote codex
 * session 不经 local Codex restart 路径 soft-close,SSH forward 仍指旧
 * bridge 端口、daemon 仍持旧 MCP session — live SEND 路径又没有 remote
 * ensure, 协同 MCP (cindy_orca / orca_worker_bridge) 持续 404 /
 * connection-refused 直到用户手动重启 session。
 *
 * 对策:bridge 重建 (ensureCodexMcpBridgeStartedForRemote 检测到实例换代)
 * 时, 对所有活跃 remote codex session 的 host 补一次 best-effort
 * ensureRemoteCodexMcpBridge — 新端口 arm 新 forward + config 重写 +
 * driftUnapplied bootstrap, 全链路自愈。ensure 幂等, live turn 时
 * bootstrap 自动推迟 (drift 持久, turn-done 挂钩补刀)。
 *
 * 本模块只放可测的纯遍历逻辑;maker-host 负责装配 deps 并在重建点调用。
 */

import type { RemoteHost } from '@cindy/maker-remote-ssh';

import { ensureRemoteCodexMcpBridge, type RemoteMcpBridgeEndpoint } from '../remote-ssh/codex-remote-mcp.js';

export interface RemoteCodexMcpRecoveryDeps {
  /** 活跃 session 中有 remoteHostId 的 codex host id 去重列表。 */
  listRemoteCodexHostIds: () => string[];
  /** host ready 才返回实例, 否则 null (跳过)。 */
  getReadyHost: (hostId: string) => RemoteHost | null;
  ensureBridgeStarted: () => Promise<RemoteMcpBridgeEndpoint | null>;
  /** live-turn 判定缺失时 (checker 未装配) 返回 null → 整体不触发 (宁可不补刀, 不误杀 turn)。 */
  getLiveTurnChecker: () => ((hostId: string) => boolean) | null;
  /**
   * Collab 全局开关 (plugin registry Tier 4)。恢复路径的 ensure 必须透传 —
   * 缺省视为开启的话, 用户禁用 Collab 后 bridge 重建会把刚清理的受管段
   * 重新注入回去 (codex-connector R21 P1)。
   */
  isCollabEnabled: () => boolean;
  log: { warn: (msg: string, meta?: Record<string, unknown>) => void };
}

export function refreshRemoteCodexMcpAfterBridgeRecreate(deps: RemoteCodexMcpRecoveryDeps): void {
  const liveTurnChecker = deps.getLiveTurnChecker();
  if (!liveTurnChecker) return;
  for (const hostId of deps.listRemoteCodexHostIds()) {
    const host = deps.getReadyHost(hostId);
    if (!host) continue;
    void ensureRemoteCodexMcpBridge(host, {
      ensureBridgeStarted: deps.ensureBridgeStarted,
      hasLiveTurnOnHost: liveTurnChecker,
      isCollabEnabled: deps.isCollabEnabled,
    }).then((result) => {
      if (!result.ok) {
        deps.log.warn('remote MCP recovery after bridge recreate failed', {
          hostId,
          reason: result.reason,
        });
      }
    });
  }
}

// ── 远端 CC query 的代际失效 (bridge 重建 / forward 端口重绑) ────────────────

export interface RemoteCcSessionLike {
  id: string;
  remoteHostId: string | null;
  isTurnRunning: () => boolean;
  detach: () => Promise<void>;
}

export interface RemoteCcInvalidationDeps {
  listRemoteCcSessions: () => RemoteCcSessionLike[];
  /** 删除 session 的「本进程已 fresh」标记 (forcedFreshCcBridgeSessions)。 */
  clearFreshMark: (sessionId: string) => void;
  log: { warn: (msg: string, meta?: Record<string, unknown>) => void };
}

/**
 * 让活跃的远端 CC query 随 MCP 代际变化 (bridge 重建 / forward 端口重绑)
 * 失效:fresh 标记无条件删 (下次注入重新 forceFresh);无 turn 的直接
 * detach (下次 send 走 lazy-resume → remoteCcQueryFactory 重新注入新
 * URL);有 turn 的只删标记不打断 — turn 结束经 maybeDetachStaleRemoteCcQuery
 * 补 detach (codex-connector R19 P2)。
 */
export function invalidateRemoteCcQueriesForMcpGenerationChange(
  deps: RemoteCcInvalidationDeps,
  opts: { hostId?: string; reason: string },
): void {
  for (const s of deps.listRemoteCcSessions()) {
    if (!s.remoteHostId) continue;
    if (opts.hostId && s.remoteHostId !== opts.hostId) continue;
    deps.clearFreshMark(s.id);
    if (s.isTurnRunning()) continue;
    void s.detach().catch((err) => {
      deps.log.warn('remote CC query detach after MCP generation change failed', {
        sessionId: s.id,
        reason: opts.reason,
        message: err instanceof Error ? err.message : String(err),
      });
    });
  }
}

export interface RemoteCcTurnSettledDeps {
  getSession: (sessionId: string) => RemoteCcSessionLike | null;
  /** 该 session 的 fresh 标记是否仍有效 (无效 = 代际已变 / 本进程未 fresh)。 */
  hasFreshMark: (sessionId: string) => boolean;
  log: { warn: (msg: string, meta?: Record<string, unknown>) => void };
}

/**
 * turn 收口时对远端 CC session 的补偿判定:fresh 标记已失效 (bridge 重建 /
 * 端口重绑时已删) 且当前无 turn → detach,让下次 send 走 factory 重新注入
 * 并 forceFresh (kill 已 idle 的旧 query);标记有效则 no-op。
 */
export function maybeDetachStaleRemoteCcQuery(deps: RemoteCcTurnSettledDeps, sessionId: string): void {
  const s = deps.getSession(sessionId);
  if (!s || !s.remoteHostId) return;
  if (deps.hasFreshMark(sessionId)) return;
  if (s.isTurnRunning()) return;
  void s.detach().catch((err) => {
    deps.log.warn('remote CC stale query detach on turn settled failed', {
      sessionId,
      message: err instanceof Error ? err.message : String(err),
    });
  });
}

