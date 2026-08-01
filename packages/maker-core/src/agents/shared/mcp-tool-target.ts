/**
 * 把 MCP 工具名归属到本 session 实际注册过的 server。
 *
 * 与 Claude `resolveMcpToolTarget` 同语义：不能按 `__` 盲切首段 —— server id 可含
 * `_`，盲切会让第三方 `cindy_browser__evil` 冒充第一方 `cindy_browser`。
 * 只在已注册 server 名里做最长前缀匹配；对不上则返回 null（调用方走原权限链）。
 */

export function resolveRegisteredMcpToolTarget(
  toolName: string,
  registeredServerNames: ReadonlySet<string>,
): { serverName: string; toolName: string } | null {
  if (!toolName.startsWith('mcp__')) return null;
  let best: { serverName: string; toolName: string } | null = null;
  for (const serverName of registeredServerNames) {
    const prefix = `mcp__${serverName}__`;
    if (!toolName.startsWith(prefix) || toolName.length <= prefix.length) continue;
    if (!best || serverName.length > best.serverName.length) {
      best = { serverName, toolName: toolName.slice(prefix.length) };
    }
  }
  return best;
}

/**
 * Cursor ACP 权限回调里的 MCP 工具名候选。
 *
 * **只采 ACP/transport 权威字段**（toolName / toolCall.title / toolCall.name）。
 * 绝不读 `rawInput` / 业务 args 里的 name/tool/toolName —— 那些可由模型伪造，
 * 会把 contacts_delete 冒充成 browser::list_tools 静默放行。
 */
export function collectMcpToolNameCandidates(
  toolName: string,
  toolCall: Record<string, unknown>,
  _toolInput?: Record<string, unknown>,
): string[] {
  const out: string[] = [];
  const push = (value: unknown) => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (!trimmed || out.includes(trimmed)) return;
    out.push(trimmed);
  };
  push(toolName);
  push(toolCall.title);
  push(toolCall.name);
  return out;
}

export function resolveMcpTargetFromCandidates(
  candidates: readonly string[],
  registeredServerNames: ReadonlySet<string>,
): { serverName: string; toolName: string } | null {
  for (const candidate of candidates) {
    const hit = resolveRegisteredMcpToolTarget(candidate, registeredServerNames);
    if (hit) return hit;
  }
  return null;
}

/** 标题/名称是否只是泛化 MCP 占位（无 server/tool 身份）。 */
export function isGenericMcpToolLabel(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return true;
  return (
    normalized === 'mcp' ||
    normalized === 'mcp: tool' ||
    normalized === 'mcp tool' ||
    normalized === 'tool' ||
    /^mcp\s*:\s*tool$/i.test(normalized)
  );
}

/**
 * 权限请求是否「看起来像 MCP」但缺少可解析的权威身份。
 * 此类必须 prompt-each-time，不能走 Auto/Full 静默放行。
 */
export function looksLikeUnresolvedMcpPermission(
  toolName: string,
  toolCall: Record<string, unknown>,
): boolean {
  const kind = typeof toolCall.kind === 'string' ? toolCall.kind.trim().toLowerCase() : '';
  if (kind === 'mcp' || kind.startsWith('mcp')) return true;
  const labels = [toolName, toolCall.title, toolCall.name]
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter(Boolean);
  if (labels.some((l) => l.startsWith('mcp__'))) return true;
  if (labels.some((l) => isGenericMcpToolLabel(l))) return true;
  if (labels.some((l) => /^mcp[\s:_-]/i.test(l))) return true;
  return false;
}

/** 会话「不再问」指纹：MCP 必须绑定 server+tool，禁止复用泛化 kind:title。 */
export function mcpSessionAllowKey(serverName: string, toolName: string): string {
  return `mcp:${serverName}:${toolName}`;
}
