import type { AgentKind } from './scheduleTypes.js';
/**
 * Agent sub-task (Claude `Task`/`Agent`, Codex `collab:*`) status model — shared between
 * desktop and the mobile device-link client so both render identical sub-agent task cards.
 *
 * Ported verbatim (behavior-identical) from the desktop renderer's `makerChatStore`
 * (`normalizeAgentTaskUpdate` / `mergeAgentTaskUpdate` / `isSameAgentTaskAlias` / the
 * `agent_task_update` reducer) and the desktop `AgentTaskCard` view-model logic, so that
 * the two clients stay in lockstep. This module is presentation-neutral (no i18n strings,
 * no React): it returns structured data; each client formats labels in its own locale.
 *
 * `agent_task_update` is a LIVE-only `AgentEvent` (never persisted), forwarded to the mobile
 * controller over the `maker:event` device-link channel. The mobile store decodes it via
 * `applyAgentTaskUpdateEvent` into a per-session map; the render layer links each update to
 * its originating `Task`/`collab:*` tool-call (or renders it standalone when orphaned).
 */

export type AgentTaskStatus = 'running' | 'completed' | 'failed' | 'stopped';

export interface AgentTaskUsage {
  totalTokens?: number;
  toolUses?: number;
  durationMs?: number;
}

export interface AgentTaskUpdate {
  provider: AgentKind;
  taskId: string;
  parentToolUseId?: string;
  status: AgentTaskStatus;
  title?: string;
  description?: string;
  summary?: string;
  outputFile?: string;
  usage?: AgentTaskUsage;
  lastToolName?: string;
  taskType?: string;
  workflowName?: string;
  model?: string;
  reasoningEffort?: string;
  receiverThreadIds?: string[];
  createdAt?: string;
  updatedAt?: string;
}

/** Tool names that spawn a sub-agent task: Claude `Task`/`Agent`, Codex collab agents. */
export function isAgentTaskToolName(toolName: string): boolean {
  return toolName === 'Agent' || toolName === 'Task' || toolName.startsWith('collab:');
}

/**
 * Validate + shape a raw `agent_task_update` event payload into an `AgentTaskUpdate`.
 * Returns null when neither a taskId nor a parentToolUseId is present (un-linkable).
 */
export function normalizeAgentTaskUpdate(
  data: unknown,
  source?: AgentKind,
): AgentTaskUpdate | null {
  if (!data || typeof data !== 'object') return null;
  const raw = data as Record<string, unknown>;
  const taskId = typeof raw.taskId === 'string' && raw.taskId.length > 0 ? raw.taskId : undefined;
  const parentToolUseId =
    typeof raw.parentToolUseId === 'string' && raw.parentToolUseId.length > 0
      ? raw.parentToolUseId
      : undefined;
  if (!taskId && !parentToolUseId) return null;
  const rawStatus = raw.status;
  const status: AgentTaskStatus =
    rawStatus === 'completed' || rawStatus === 'failed' || rawStatus === 'stopped'
      ? rawStatus
      : 'running';
  const provider: AgentKind =
    raw.provider === 'codex' || raw.provider === 'claude-code' || raw.provider === 'cursor'
      ? raw.provider
      : source === 'codex'
        ? 'codex'
        : source === 'cursor'
          ? 'cursor'
          : 'claude-code';
  const usageRaw = raw.usage && typeof raw.usage === 'object' ? raw.usage as Record<string, unknown> : null;
  const usage: AgentTaskUsage | undefined = usageRaw
    ? {
        ...(typeof usageRaw.totalTokens === 'number' ? { totalTokens: usageRaw.totalTokens } : {}),
        ...(typeof usageRaw.toolUses === 'number' ? { toolUses: usageRaw.toolUses } : {}),
        ...(typeof usageRaw.durationMs === 'number' ? { durationMs: usageRaw.durationMs } : {}),
      }
    : undefined;
  return {
    provider,
    taskId: taskId ?? parentToolUseId!,
    ...(parentToolUseId ? { parentToolUseId } : {}),
    status,
    ...(typeof raw.title === 'string' && raw.title ? { title: raw.title } : {}),
    ...(typeof raw.description === 'string' && raw.description ? { description: raw.description } : {}),
    ...(typeof raw.summary === 'string' && raw.summary ? { summary: raw.summary } : {}),
    ...(typeof raw.outputFile === 'string' && raw.outputFile ? { outputFile: raw.outputFile } : {}),
    ...(usage && Object.keys(usage).length > 0 ? { usage } : {}),
    ...(typeof raw.lastToolName === 'string' && raw.lastToolName ? { lastToolName: raw.lastToolName } : {}),
    ...(typeof raw.taskType === 'string' && raw.taskType ? { taskType: raw.taskType } : {}),
    ...(typeof raw.workflowName === 'string' && raw.workflowName ? { workflowName: raw.workflowName } : {}),
    ...(typeof raw.model === 'string' && raw.model ? { model: raw.model } : {}),
    ...(typeof raw.reasoningEffort === 'string' && raw.reasoningEffort ? { reasoningEffort: raw.reasoningEffort } : {}),
    ...(Array.isArray(raw.receiverThreadIds)
      ? { receiverThreadIds: raw.receiverThreadIds.filter((id): id is string => typeof id === 'string') }
      : {}),
    ...(typeof raw.createdAt === 'string' && raw.createdAt ? { createdAt: raw.createdAt } : {}),
    ...(typeof raw.updatedAt === 'string' && raw.updatedAt ? { updatedAt: raw.updatedAt } : {}),
  };
}

/** Field-wise merge of a newer update over a prior one (newer non-empty fields win). */
export function mergeAgentTaskUpdate(prev: AgentTaskUpdate | undefined, next: AgentTaskUpdate): AgentTaskUpdate {
  if (!prev) return next;
  return {
    ...prev,
    ...next,
    usage: next.usage ?? prev.usage,
    title: next.title ?? prev.title,
    description: next.description ?? prev.description,
    summary: next.summary ?? prev.summary,
    outputFile: next.outputFile ?? prev.outputFile,
    lastToolName: next.lastToolName ?? prev.lastToolName,
    createdAt: prev.createdAt ?? next.createdAt,
    updatedAt: next.updatedAt ?? prev.updatedAt,
  };
}

/** Two updates describe the same task if their taskId/parentToolUseId aliases overlap. */
export function isSameAgentTaskAlias(left: AgentTaskUpdate, right: AgentTaskUpdate): boolean {
  if (left.taskId === right.taskId) return true;
  if (left.parentToolUseId && left.parentToolUseId === right.taskId) return true;
  if (right.parentToolUseId && right.parentToolUseId === left.taskId) return true;
  return Boolean(left.parentToolUseId && right.parentToolUseId && left.parentToolUseId === right.parentToolUseId);
}

/**
 * Reduce a raw `agent_task_update` event into the per-session task-update map.
 * Mirrors the desktop `makerChatStore` reducer: keys every update by its taskId and
 * parentToolUseId (plus any aliased existing keys) so a single task is reachable by either
 * the live taskId or the originating tool-call id. Returns a NEW map, or null when the
 * payload is un-linkable (caller should treat null as a no-op). `nowIso` is injected so the
 * function stays pure/deterministic for tests.
 */
export function applyAgentTaskUpdateEvent(
  prevMap: ReadonlyMap<string, AgentTaskUpdate> | undefined,
  data: unknown,
  source: AgentKind | undefined,
  nowIso: string,
): Map<string, AgentTaskUpdate> | null {
  const update = normalizeAgentTaskUpdate(data, source);
  if (!update) return null;
  const nextMap = new Map(prevMap ?? []);
  const keys = new Set<string>([update.taskId]);
  if (update.parentToolUseId) keys.add(update.parentToolUseId);
  for (const [key, value] of nextMap) {
    if (!isSameAgentTaskAlias(value, update)) continue;
    keys.add(key);
    keys.add(value.taskId);
    if (value.parentToolUseId) keys.add(value.parentToolUseId);
  }
  const existing = [...keys].map((key) => nextMap.get(key)).find((value): value is AgentTaskUpdate => Boolean(value));
  const timedUpdate: AgentTaskUpdate = {
    ...update,
    createdAt: update.createdAt ?? existing?.createdAt ?? nowIso,
    updatedAt: update.updatedAt ?? nowIso,
  };
  let merged: AgentTaskUpdate | undefined;
  for (const key of keys) {
    merged = mergeAgentTaskUpdate(nextMap.get(key), merged ?? timedUpdate);
  }
  if (!merged) merged = timedUpdate;
  for (const key of keys) nextMap.set(key, merged);
  return nextMap;
}

/**
 * Look up the live update for a tool-call by its tool-use id, then its client id —
 * the two keys the reducer indexes a task under. Mirrors desktop `findTaskUpdate`.
 */
export function findAgentTaskUpdate(
  taskUpdates: ReadonlyMap<string, AgentTaskUpdate> | undefined,
  toolUseId: string | null | undefined,
  clientId: string | null | undefined,
): AgentTaskUpdate | undefined {
  if (!taskUpdates) return undefined;
  if (toolUseId) {
    const byToolUseId = taskUpdates.get(toolUseId);
    if (byToolUseId) return byToolUseId;
  }
  if (clientId) return taskUpdates.get(clientId);
  return undefined;
}

/**
 * Presentation-neutral view-model for a sub-agent task card, derived from the originating
 * tool-call input and/or the live update. Mirrors the desktop `AgentTaskCard` field-selection
 * (title fallback chain, description/summary precedence, status inference). Returns structured
 * data only — each client renders status/provider/usage labels in its own locale.
 */
export interface AgentTaskCardModel {
  status: AgentTaskStatus;
  provider: AgentKind;
  /** Best title, or null when nothing usable was found (caller supplies its own fallback). */
  title: string | null;
  description?: string;
  summary?: string;
  lastToolName?: string;
  outputFile?: string;
  totalTokens?: number;
  toolUses?: number;
  durationMs?: number;
}

export function buildAgentTaskCardModel(input: {
  toolName?: string;
  toolInput?: unknown;
  update?: AgentTaskUpdate;
  result?: string;
}): AgentTaskCardModel {
  const { toolName, toolInput, update, result } = input;
  const status: AgentTaskStatus = update?.status ?? (result ? 'completed' : 'running');
  const provider: AgentKind =
    update?.provider ?? (toolName?.startsWith('collab:') ? 'codex' : 'claude-code');
  const title = compactText(
    update?.title
      ?? readInputString(toolInput, ['description', 'task', 'name'])
      ?? readInputString(toolInput, ['prompt']),
    96,
  );
  const description = compactText(
    update?.description ?? readInputString(toolInput, ['prompt', 'description', 'task']),
  );
  const summary = detailText(result, update?.summary);
  return {
    status,
    provider,
    title: title ?? null,
    ...(description ? { description } : {}),
    ...(summary ? { summary } : {}),
    ...(update?.lastToolName ? { lastToolName: update.lastToolName } : {}),
    ...(update?.outputFile ? { outputFile: update.outputFile } : {}),
    ...(typeof update?.usage?.totalTokens === 'number' ? { totalTokens: update.usage.totalTokens } : {}),
    ...(typeof update?.usage?.toolUses === 'number' ? { toolUses: update.usage.toolUses } : {}),
    ...(typeof update?.usage?.durationMs === 'number' ? { durationMs: update.usage.durationMs } : {}),
  };
}

function readInputString(input: unknown, keys: string[]): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const obj = input as Record<string, unknown>;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function compactText(text: string | undefined, max = 260): string | undefined {
  if (!text) return undefined;
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}…`;
}

function detailText(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}
