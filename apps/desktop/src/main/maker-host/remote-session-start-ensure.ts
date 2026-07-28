/**
 * ensureRemoteReadyForSessionStart 的跨层 holder。
 *
 * 真实现定义在 maker-ipc/register.ts 的 IPC 注册闭包里 (依赖同层大量闭包:
 * ensureRemoteHostReady / cc-manager install / codex MCP ensure / maker),
 * maker-host 构造 orca bridge deps 时拿不到;经本模块注入 / 读取,避免
 * maker-host 反向依赖 maker-ipc (依赖方向见 architecture-invariants)。
 *
 * 写入时机:register.ts 注册 IPC 时 (app 启动期, 早于任何 bridge 回调)。
 * 读取时机:orca bridge rehydrate remote session 前;未注入时 no-op,等价于
 * bridge 既有行为 (无远端能力的环境)。
 */

import type { AgentKind } from '@cindy/maker-core';

export type RemoteSessionStartEnsure = (params: {
  session?: { agentKind: AgentKind; remoteHostId: string | null } | null;
  createOpts?: unknown;
}) => Promise<void>;

let impl: RemoteSessionStartEnsure | null = null;

export function setRemoteSessionStartEnsure(fn: RemoteSessionStartEnsure): void {
  impl = fn;
}

export function getRemoteSessionStartEnsure(): RemoteSessionStartEnsure | null {
  return impl;
}

/**
 * codex 远端 host 的 live-turn 判定 (register.ts 的 coordinator 真源)。
 * bridge 重建后的恢复遍历 (remote-codex-mcp-recovery) 经它决定 bootstrap
 * 是否推迟;未装配时恢复遍历整体不触发 (宁可不补刀, 不误杀 turn)。
 */
export type RemoteCodexLiveTurnChecker = (hostId: string) => boolean;

let liveTurnChecker: RemoteCodexLiveTurnChecker | null = null;

export function setRemoteCodexLiveTurnChecker(fn: RemoteCodexLiveTurnChecker): void {
  liveTurnChecker = fn;
}

export function getRemoteCodexLiveTurnChecker(): RemoteCodexLiveTurnChecker | null {
  return liveTurnChecker;
}
