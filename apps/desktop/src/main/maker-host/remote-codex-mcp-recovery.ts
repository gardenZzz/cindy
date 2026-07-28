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
