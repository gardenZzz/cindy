/**
 * 把 `mcp__<server>__<tool>` 形态的工具名解析回 (serverName, toolName)。
 *
 * Claude Code 与 Pi 共用同一份实现 —— 两侧都用它决定「这个 MCP 工具属于哪个 server」,
 * 再把 server 名交给 host 的 `getMcpToolApprovalPolicy`。归属判定错了就等于审批策略
 * 认错人,必须只有一份真源。
 *
 * 命名格式为 `mcp__<server>__<tool>`, 但**不能**按 `__` 盲切首段当 server ——
 * server 名自身可以含 `__`(自定义 MCP 的 id 正则是 `/^[a-z0-9_-]+$/`, 下划线合法)。
 * 盲切会让 id 为 `cindy_browser__evil` 的第三方 server 被识别成第一方 `cindy_browser`,
 * 直接继承信任表里的静默放行 —— 这是一条实打实的提权路径。
 *
 * 因此只在**本 session 实际注册过**的 server 名里做前缀匹配, 命中多个时取最长者
 * (`cindy_browser__evil` 胜过 `cindy_browser`), 保证归属唯一。名字对不上任何已注册
 * server 时返回 null, 调用方按"不查策略"处理 —— 走原有权限链, 不放行。
 */
export function resolveMcpToolTarget(
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
    const hit = resolveMcpToolTarget(candidate, registeredServerNames);
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
