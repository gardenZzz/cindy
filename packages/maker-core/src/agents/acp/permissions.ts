/**
 * ACP session/request_permission ↔ Cindy InteractionRequest / Decision。
 *
 * Spike (issue #7): Cursor `allow-always` 会调用 persistAllowlistEntry，写入
 * `~/.cursor/cli-config.json` 的 permissions.allow（机器级）。因此 Cindy 永不向
 * Cursor 回 allow-always，只回 allow-once / reject-once；「本会话不再问」记在
 * Cindy 层 sessionAllowKeys。
 */

import type {
  InteractionDecision,
  InteractionRequest,
} from '../../types/events.js';
import type {
  PermissionOption,
  RequestPermissionParams,
  RequestPermissionResult,
  ToolCallUpdate,
  ToolKind,
} from './protocol.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Auto 档客户端分类器：这些 kind 静默放行，其余询问。 */
export const ACP_AUTO_ALLOW_KINDS: ReadonlySet<string> = new Set([
  'read',
  'search',
  'think',
]);

export function findPermissionOption(
  options: readonly PermissionOption[] | undefined,
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always',
): PermissionOption | undefined {
  if (!Array.isArray(options)) return undefined;
  return options.find((o) => o && o.kind === kind);
}

export function permissionToolCall(
  params: RequestPermissionParams | Record<string, unknown>,
): Partial<ToolCallUpdate> {
  const toolCall = (params as RequestPermissionParams).toolCall;
  return isRecord(toolCall) ? (toolCall as Partial<ToolCallUpdate>) : {};
}

export function toolNameFromAcpToolCall(toolCall: Partial<ToolCallUpdate>): string {
  const kind = typeof toolCall.kind === 'string' ? toolCall.kind : '';
  if (kind === 'execute') return 'exec';
  if (kind === 'edit' || kind === 'delete' || kind === 'move') return kind;
  if (kind === 'read' || kind === 'search' || kind === 'fetch' || kind === 'think') {
    return kind;
  }
  if (typeof toolCall.title === 'string' && toolCall.title.trim()) {
    return toolCall.title.trim();
  }
  return kind || 'tool';
}

export function toolInputFromAcpToolCall(
  toolCall: Partial<ToolCallUpdate>,
): Record<string, unknown> {
  if (isRecord(toolCall.rawInput)) {
    return { ...toolCall.rawInput };
  }
  const input: Record<string, unknown> = {};
  if (typeof toolCall.title === 'string') input.title = toolCall.title;
  if (typeof toolCall.kind === 'string') input.kind = toolCall.kind;
  if (Array.isArray(toolCall.content) && toolCall.content.length > 0) {
    input.content = toolCall.content;
  }
  return input;
}

/**
 * 会话级「不再问」指纹。优先稳定字段（command / path），否则 kind+title。
 */
export function sessionAllowKeyFromToolCall(toolCall: Partial<ToolCallUpdate>): string {
  const kind = typeof toolCall.kind === 'string' ? toolCall.kind : 'other';
  const input = toolInputFromAcpToolCall(toolCall);
  if (typeof input.command === 'string' && input.command.trim()) {
    // 与 Cursor allowlist `Shell(uname)` 同粒度：取 argv0
    const argv0 = input.command.trim().split(/\s+/)[0] ?? input.command.trim();
    return `execute:${argv0}`;
  }
  if (typeof input.path === 'string' && input.path.trim()) {
    return `${kind}:${input.path.trim()}`;
  }
  if (typeof input.file_path === 'string' && input.file_path.trim()) {
    return `${kind}:${input.file_path.trim()}`;
  }
  const title = typeof toolCall.title === 'string' ? toolCall.title.trim() : '';
  return `${kind}:${title || toolNameFromAcpToolCall(toolCall)}`;
}

export function sessionAllowKeyFromSuggestion(update: unknown): string | null {
  if (!isRecord(update)) return null;
  if (typeof update.sessionAllowKey === 'string' && update.sessionAllowKey) {
    return update.sessionAllowKey;
  }
  return null;
}

export function toInteractionRequest(args: {
  requestId: string;
  params: RequestPermissionParams | Record<string, unknown>;
  suggestions?: unknown[];
}): InteractionRequest {
  const toolCall = permissionToolCall(args.params);
  const toolName = toolNameFromAcpToolCall(toolCall);
  const input = toolInputFromAcpToolCall(toolCall);
  const title = typeof toolCall.title === 'string' ? toolCall.title : undefined;
  const description = extractPermissionDescription(args.params, toolCall);
  return {
    kind: 'permission',
    requestId: args.requestId,
    toolName,
    input,
    title,
    displayName: title ?? toolName,
    description,
    suggestions: args.suggestions,
    metadata: {
      acpToolCallId: toolCall.toolCallId,
      acpKind: toolCall.kind,
      sessionAllowKey: sessionAllowKeyFromToolCall(toolCall),
    },
  };
}

function extractPermissionDescription(
  params: RequestPermissionParams | Record<string, unknown>,
  toolCall: Partial<ToolCallUpdate>,
): string | undefined {
  if (typeof (params as { description?: unknown }).description === 'string') {
    return (params as { description: string }).description;
  }
  const content = toolCall.content;
  if (!Array.isArray(content)) return undefined;
  for (const item of content) {
    if (!isRecord(item)) continue;
    if (item.type === 'content' && isRecord(item.content) && item.content.type === 'text') {
      if (typeof item.content.text === 'string' && item.content.text.trim()) {
        return item.content.text;
      }
    }
    if (item.type === 'text' && typeof item.text === 'string' && item.text.trim()) {
      return item.text;
    }
  }
  return undefined;
}

/**
 * 把 Cindy 决策翻成 ACP selected outcome。
 * **永不**选择 allow_always（机器级持久化）；会话记忆由调用方处理。
 */
export function toRequestPermissionResult(
  decision: Extract<InteractionDecision, { kind: 'permission' }>,
  options: readonly PermissionOption[] | undefined,
): RequestPermissionResult {
  const allowOnce = findPermissionOption(options, 'allow_once');
  const rejectOnce = findPermissionOption(options, 'reject_once');
  if (decision.behavior === 'allow') {
    if (allowOnce) {
      return { outcome: { outcome: 'selected', optionId: allowOnce.optionId } };
    }
    // 防御: 上游未给 allow_once 时仍不回 allow_always
    return { outcome: { outcome: 'selected', optionId: 'allow-once' } };
  }
  if (rejectOnce) {
    return { outcome: { outcome: 'selected', optionId: rejectOnce.optionId } };
  }
  return { outcome: { outcome: 'selected', optionId: 'reject-once' } };
}

export function cancelledPermissionResult(): RequestPermissionResult {
  return { outcome: { outcome: 'cancelled' } };
}

export function autoClassifierAllowsKind(kind: ToolKind | null | undefined): boolean {
  if (typeof kind !== 'string' || !kind) return false;
  return ACP_AUTO_ALLOW_KINDS.has(kind);
}
