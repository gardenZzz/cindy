/**
 * 手机端跨 Agent 切换的纯契约适配：只接收 desktop main 的公开 pending intent，
 * 不在控制端持久化第二份真相。
 */
import type { MobileAgentCapabilities } from './agentCapabilities';
import type { RemoteSession, RemoteSessionAgentSwitchIntent } from './types';
import type { AgentKind } from '@cindy/maker-shared';

export type MobileSessionAgentKind = AgentKind;

/** DB 会话行的 agent_kind 值域（与 desktop sessions.agent_kind 对齐）。 */
export type DbSessionAgentKind = 'cc' | 'codex' | 'cursor' | 'pi';

/** DB 'cc'/'codex'/'cursor'/'pi' → maker-core AgentKind。 */
export function toMakerAgentKind(dbKind: string | null | undefined): MobileSessionAgentKind {
  if (dbKind === 'codex') return 'codex';
  if (dbKind === 'cursor') return 'cursor';
  if (dbKind === 'pi') return 'pi';
  return 'claude-code';
}

/** maker-core AgentKind → DB agent_kind。 */
export function toDbAgentKind(kind: MobileSessionAgentKind): DbSessionAgentKind {
  if (kind === 'codex') return 'codex';
  if (kind === 'cursor') return 'cursor';
  if (kind === 'pi') return 'pi';
  return 'cc';
}

/** 将不可信 device-link payload 收窄为公开 intent；非法值按“无意图”处理。 */
export function normalizeSessionAgentSwitchIntent(
  value: unknown,
): RemoteSessionAgentSwitchIntent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (
    item.targetAgentKind !== 'claude-code'
    && item.targetAgentKind !== 'codex'
    && item.targetAgentKind !== 'cursor'
    && item.targetAgentKind !== 'pi'
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
  // 远程 Agent:只在这笔切换同时换 Agent 所在电脑时出现(null = 改回被控电脑本机)。
  // 缺省 = 位置不变;非空 string / null 之外的脏值与其它字段同口径判非法。
  if (
    item.agentDeviceId !== undefined
    && item.agentDeviceId !== null
    && (typeof item.agentDeviceId !== 'string' || item.agentDeviceId.length === 0)
  ) return null;
  return {
    targetAgentKind: item.targetAgentKind,
    model: item.model,
    providerId: typeof item.providerId === 'string' ? item.providerId : null,
    ...(typeof item.effort === 'string' && item.effort.length > 0
      ? { effort: item.effort }
      : {}),
    ...(typeof item.fastMode === 'boolean' ? { fastMode: item.fastMode } : {}),
    ...(item.agentDeviceId !== undefined
      ? { agentDeviceId: item.agentDeviceId as string | null }
      : {}),
  };
}

/** DB 会话行的 cc/codex/cursor 映射到 maker agent kind。 */
export function sessionAgentKind(session: Pick<RemoteSession, 'agentKind'>): MobileSessionAgentKind {
  return toMakerAgentKind(session.agentKind);
}

/**
 * 手机是否应展示 Agent 分段。四家(Claude Code / Codex / Pi / Cursor)同口径:
 * 纯粹依赖被控端按当前任务真实 Agent 上报的 `supportsSessionAgentSwitch` 能力位,
 * 不在控制端写死第二份「源是某 Agent 就隐藏」的判断;远程 SSH / Orca 任务继续排除。
 * 老被控端对 Cursor 仍报 false -> 入口正确隐藏(优雅降级,升级后自然获得)。
 */
export function supportsMobileSessionAgentSwitch(
  session: Pick<RemoteSession, 'remoteHostId' | 'orcaRole' | 'agentKind'>,
  capabilities: MobileAgentCapabilities | null,
): boolean {
  return capabilities?.supportsSessionAgentSwitch === true
    && !session.remoteHostId
    && !session.orcaRole;
}

export function mobileAgentLabel(agentKind: MobileSessionAgentKind): string {
  if (agentKind === 'codex') return 'Codex';
  if (agentKind === 'cursor') return 'Cursor';
  if (agentKind === 'pi') return 'Pi';
  return 'Claude Code';
}

/** 短标签（新建页 / 鉴权提示用；Claude Code → Claude）。 */
export function mobileAgentShortLabel(agentKind: MobileSessionAgentKind): string {
  if (agentKind === 'codex') return 'Codex';
  if (agentKind === 'cursor') return 'Cursor';
  if (agentKind === 'pi') return 'Pi';
  return 'Claude';
}

export function mobileAgentLabelFromUnknown(agentKind: unknown): string {
  if (agentKind === 'codex') return 'Codex';
  if (agentKind === 'cursor') return 'Cursor';
  if (agentKind === 'pi') return 'Pi';
  return 'Claude Code';
}

export function mobileAgentVendor(agentKind: MobileSessionAgentKind): DbSessionAgentKind {
  if (agentKind === 'codex') return 'codex';
  if (agentKind === 'cursor') return 'cursor';
  if (agentKind === 'pi') return 'pi';
  return 'cc';
}

/** 任务的 Agent 是否在同账号另一台电脑上运行(desktop sessions.agent_device_id 非空)。 */
export function sessionAgentRunsOnOtherComputer(
  session: Pick<RemoteSession, 'agentDeviceId'> | null | undefined,
): boolean {
  return typeof session?.agentDeviceId === 'string' && session.agentDeviceId.length > 0;
}

/** pending intent 是否同时改 Agent 所在电脑(带 agentDeviceId 键,null = 改回被控电脑)。 */
export function intentChangesAgentLocation(
  intent: RemoteSessionAgentSwitchIntent | null | undefined,
): boolean {
  return !!intent && intent.agentDeviceId !== undefined;
}

/**
 * 下一条消息时 Agent 所在的电脑(与桌面 effectiveAgentDeviceId 同口径):pending intent 带
 * 位置就用它,否则用任务当前的位置。null = 被控电脑本机。
 */
export function effectiveAgentDeviceId(
  session: Pick<RemoteSession, 'agentDeviceId'> | null | undefined,
  intent: RemoteSessionAgentSwitchIntent | null | undefined,
): string | null {
  if (intent && intent.agentDeviceId !== undefined) return intent.agentDeviceId;
  return sessionAgentRunsOnOtherComputer(session) ? session!.agentDeviceId! : null;
}

/**
 * 选中一行模型时 Agent 位置怎么处理(与桌面已建任务的换电脑规则同口径):
 * - catalogDeviceId = 这一行来自哪台电脑的目录(null = 被控电脑本机);
 * - relocateTo:与任务当前位置不同才带给被控端(switchSessionAgent 第 7 参);选回任务当前
 *   所在电脑 = 撤销挂着的换位置,不带位置;
 * - needsConfirm:换到下一条消息时所在电脑以外、且不是任务当前所在电脑时才确认(已确认过的
 *   同一目标、或撤销挂着的换位置都不再问)。
 */
export function resolveAgentLocationPick(input: {
  session: Pick<RemoteSession, 'agentDeviceId'> | null | undefined;
  intent: RemoteSessionAgentSwitchIntent | null | undefined;
  catalogDeviceId: string | null;
}): { relocateTo: string | null | undefined; needsConfirm: boolean } {
  const current = sessionAgentRunsOnOtherComputer(input.session)
    ? input.session!.agentDeviceId!
    : null;
  const effective = effectiveAgentDeviceId(input.session, input.intent);
  const target = input.catalogDeviceId;
  return {
    relocateTo: target !== current ? target : undefined,
    needsConfirm: target !== effective && target !== current,
  };
}

/** agent_switch 边界行里 Agent 换电脑后的目标位置;缺 toAgentDeviceId 键 = 没换电脑。 */
export type AgentSwitchLocationTarget =
  | { kind: 'named'; name: string }
  | { kind: 'thisComputer' }
  | { kind: 'otherComputer' };

export function readAgentSwitchLocationTarget(
  data: Record<string, unknown> | undefined,
): AgentSwitchLocationTarget | null {
  if (!data || !Object.prototype.hasOwnProperty.call(data, 'toAgentDeviceId')) return null;
  const name = typeof data.toAgentDeviceName === 'string' ? data.toAgentDeviceName.trim() : '';
  if (name) return { kind: 'named', name };
  return data.toAgentDeviceId === null ? { kind: 'thisComputer' } : { kind: 'otherComputer' };
}
