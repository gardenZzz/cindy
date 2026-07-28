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
