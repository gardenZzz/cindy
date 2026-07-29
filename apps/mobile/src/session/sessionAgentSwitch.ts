/**
 * 手机端跨 Agent 切换的纯契约适配：只接收 desktop main 的公开 pending intent，
 * 不在控制端持久化第二份真相。
 */
import type {
  MobileSessionAgentSwitchIntent,
} from '@cindy/maker-shared/device-link-contract';

import type { MobileAgentCapabilities } from './agentCapabilities';
import type { RemoteSession } from './types';
import type { AgentKind } from '@cindy/maker-shared';

export type MobileSessionAgentKind = AgentKind;

/** DB 会话行的 agent_kind 值域（与 desktop sessions.agent_kind 对齐）。 */
export type DbSessionAgentKind = 'cc' | 'codex' | 'cursor';

/** DB 'cc'/'codex'/'cursor' → maker-core AgentKind。 */
export function toMakerAgentKind(dbKind: string | null | undefined): MobileSessionAgentKind {
  if (dbKind === 'codex') return 'codex';
  if (dbKind === 'cursor') return 'cursor';
  return 'claude-code';
}

/** maker-core AgentKind → DB agent_kind。 */
export function toDbAgentKind(kind: MobileSessionAgentKind): DbSessionAgentKind {
  if (kind === 'codex') return 'codex';
  if (kind === 'cursor') return 'cursor';
  return 'cc';
}

/** 将不可信 device-link payload 收窄为公开 intent；非法值按“无意图”处理。 */
export function normalizeSessionAgentSwitchIntent(
  value: unknown,
): MobileSessionAgentSwitchIntent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (
    item.targetAgentKind !== 'claude-code'
    && item.targetAgentKind !== 'codex'
    && item.targetAgentKind !== 'cursor'
  ) {
    return null;
  }
  if (typeof item.model !== 'string' || item.model.length === 0) return null;
  // providerId 缺失(undefined)按 null 处理,与桌面 projectPendingAgentSwitchIntent 的
  // `providerId ?? null` 语义对齐——只有出现非 string / 非 null / 非 undefined 的脏值才判非法,
  // 避免协议演进或旧 host 漏发该字段时把合法 pending intent 静默丢弃。
  if (item.providerId != null && typeof item.providerId !== 'string') return null;
  if (item.effort !== undefined && typeof item.effort !== 'string') return null;
  if (item.fastMode !== undefined && typeof item.fastMode !== 'boolean') return null;
  return {
    targetAgentKind: item.targetAgentKind,
    model: item.model,
    providerId: typeof item.providerId === 'string' ? item.providerId : null,
    ...(typeof item.effort === 'string' && item.effort.length > 0
      ? { effort: item.effort }
      : {}),
    ...(typeof item.fastMode === 'boolean' ? { fastMode: item.fastMode } : {}),
  };
}

/** DB 会话行的 cc/codex/cursor 映射到 maker agent kind。 */
export function sessionAgentKind(session: Pick<RemoteSession, 'agentKind'>): MobileSessionAgentKind {
  return toMakerAgentKind(session.agentKind);
}

/** 手机是否应展示 Agent 分段；远程 SSH / Orca / Cursor 会话继续保持单 Agent。 */
export function supportsMobileSessionAgentSwitch(
  session: Pick<RemoteSession, 'remoteHostId' | 'orcaRole' | 'agentKind'>,
  capabilities: MobileAgentCapabilities | null,
): boolean {
  // Cursor 一期不做会话内引擎切换（与 desktop GET_CAPABILITIES / switch handler 对齐）。
  if (session.agentKind === 'cursor') return false;
  return capabilities?.supportsSessionAgentSwitch === true
    && !session.remoteHostId
    && !session.orcaRole;
}

export function mobileAgentLabel(agentKind: MobileSessionAgentKind): string {
  if (agentKind === 'codex') return 'Codex';
  if (agentKind === 'cursor') return 'Cursor';
  return 'Claude Code';
}

/** 短标签（新建页 / 鉴权提示用；Claude Code → Claude）。 */
export function mobileAgentShortLabel(agentKind: MobileSessionAgentKind): string {
  if (agentKind === 'codex') return 'Codex';
  if (agentKind === 'cursor') return 'Cursor';
  return 'Claude';
}
