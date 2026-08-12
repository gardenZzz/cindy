/**
 * maker-core AgentKind ↔ New Maker 草稿槽 / device-link push 槽的唯一映射。
 *
 * 历史二元实现把非 claude-code 一律当 codex，Cursor 会：
 *   - GET 读到错 vendor / push 缺 cursor 槽
 *   - APPLY 被 INVALID_PARAMS 拒掉
 *   - 本地 session→draft 同步写进 cc 槽
 * 全链必须复用本模块，禁止再写 `=== 'codex' ? 'codex' : 'cc'` 一类二元兜底。
 */
import type { AgentKind } from '@cindy/maker-core';

/** New Maker draft / lastByVendor / main cache 用的 vendor 键（不含 orca）。 */
export type DraftVendorKey = 'cc' | 'codex' | 'cursor' | 'pi';

/** `maker:new-maker-draft:changed` push payload 的 per-agent 槽名。 */
export type DraftPushSlot = 'claudeCode' | 'codex' | 'cursor' | 'pi';

export const MAKER_CORE_AGENT_KINDS = [
  'claude-code',
  'codex',
  'cursor',
  'pi',
] as const satisfies readonly AgentKind[];

export function isMakerCoreAgentKind(value: unknown): value is AgentKind {
  return value === 'claude-code' || value === 'codex' || value === 'cursor' || value === 'pi';
}

/** maker-core AgentKind → draft / lastByVendor / cache VendorKey。 */
export function agentKindToDraftVendor(kind: AgentKind): DraftVendorKey {
  if (kind === 'codex') return 'codex';
  if (kind === 'cursor') return 'cursor';
  if (kind === 'pi') return 'pi';
  return 'cc';
}

/** draft / lastByVendor / cache VendorKey → maker-core AgentKind(agentKindToDraftVendor 的逆)。 */
export function draftVendorToAgentKind(vendor: DraftVendorKey): AgentKind {
  if (vendor === 'codex') return 'codex';
  if (vendor === 'cursor') return 'cursor';
  if (vendor === 'pi') return 'pi';
  return 'claude-code';
}

/** maker-core AgentKind → NEW_MAKER_DRAFT_CHANGED push payload 槽。 */
export function agentKindToDraftPushSlot(kind: AgentKind): DraftPushSlot {
  if (kind === 'codex') return 'codex';
  if (kind === 'cursor') return 'cursor';
  if (kind === 'pi') return 'pi';
  return 'claudeCode';
}
