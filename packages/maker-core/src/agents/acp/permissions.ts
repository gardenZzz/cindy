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
} from './protocol.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Auto 档**候选** kind：仅这些 kind 有资格进入静默放行评估。
 * 最终是否放行还必须看 tool 名与完整 input（尤其 path）——见
 * {@link classifyAcpAutoPermission}。绝不能只凭 kind 放行。
 */
export const ACP_AUTO_ALLOW_KINDS: ReadonlySet<string> = new Set([
  'read',
  'search',
  'think',
]);

/** Auto 分类器裁决：allow = 静默放行；ask = 弹权限卡（会话仍可留在 Auto）。 */
export type AutoPermissionVerdict = 'allow' | 'ask';

export interface AutoPermissionClassifyArgs {
  toolName: string;
  input: Record<string, unknown>;
  /** ACP toolCall.kind；缺失或不在候选集 → ask。 */
  kind?: string | null;
}

const PATH_INPUT_KEYS = [
  'path',
  'file_path',
  'filePath',
  'target',
  'target_directory',
  'targetDirectory',
  'directory',
  'dir',
  'cwd',
] as const;

const PRIVATE_KEY_BASENAME_RE = /^id_(?:rsa|dsa|ecdsa|ed25519)$/i;
const SENSITIVE_EXTENSION_RE = /\.(?:pem|key|p12|pfx|jks|keystore|kdbx)$/i;
const SENSITIVE_DIR_RE = /(?:^|\/|\\)(?:\.ssh|\.aws|\.gnupg|\.kube|\.azure|\.docker)(?:\/|\\|$)/i;
const SENSITIVE_BASENAME_RE =
  /(?:^|\/|\\)(?:\.env(?:\..+)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|credentials(?:\.json)?|service-account\.json)$/i;

/** 从 tool input 收集可能是路径的字符串（含嵌套一层的常见字段）。 */
function collectPathCandidates(input: Record<string, unknown>): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === 'string' && v.trim()) out.push(v.trim());
  };
  for (const key of PATH_INPUT_KEYS) {
    push(input[key]);
  }
  // 常见嵌套：{ file: { path } } / { target_file: '...' }
  push(input.target_file);
  push(input.targetFile);
  if (isRecord(input.file)) {
    for (const key of PATH_INPUT_KEYS) push(input.file[key]);
  }
  return out;
}

/** 高置信敏感路径：ssh 私钥、凭证目录、常见密钥扩展名等。 */
export function isSensitiveAutoPermissionPath(pathValue: string): boolean {
  const normalized = pathValue.replace(/\\/g, '/');
  const lower = normalized.toLowerCase();
  const base = lower.includes('/') ? lower.slice(lower.lastIndexOf('/') + 1) : lower;
  if (PRIVATE_KEY_BASENAME_RE.test(base)) return true;
  if (SENSITIVE_EXTENSION_RE.test(base)) return true;
  if (SENSITIVE_DIR_RE.test(normalized)) return true;
  if (SENSITIVE_BASENAME_RE.test(normalized)) return true;
  if (/(?:^|\/)(?:secrets?|credentials?)\//i.test(normalized)) return true;
  return false;
}

function inputTouchesSensitivePath(input: Record<string, unknown>): boolean {
  for (const candidate of collectPathCandidates(input)) {
    if (isSensitiveAutoPermissionPath(candidate)) return true;
  }
  return false;
}

/**
 * Cindy 侧 Auto 权限分类器（Cursor ACP 用）。
 *
 * Claude Auto 走 SDK 远程 security monitor；Codex Auto 走 Guardian。
 * Cursor 无 vendor 分类器，因此在客户端用 tool 名 + 完整 input 做保守裁决：
 * 仅 read/search/think 且未触及敏感路径时 allow，其余一律 ask。
 */
export function classifyAcpAutoPermission(
  args: AutoPermissionClassifyArgs,
): AutoPermissionVerdict {
  const kind = args.kind;
  if (typeof kind !== 'string' || !kind || !ACP_AUTO_ALLOW_KINDS.has(kind)) {
    return 'ask';
  }
  if (inputTouchesSensitivePath(args.input)) {
    return 'ask';
  }
  return 'allow';
}

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
