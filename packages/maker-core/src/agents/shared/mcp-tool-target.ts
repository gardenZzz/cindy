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
 * Cursor ACP 权限回调里可能出现的 MCP 工具名候选。
 * 实测 session/update 常不带 server/tool；permission 的 title / name / rawInput
 * 仍可能是 `mcp__<server>__<tool>`，逐个试归属。
 */
export function collectMcpToolNameCandidates(
  toolName: string,
  toolCall: Record<string, unknown>,
  toolInput: Record<string, unknown>,
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
  push(toolInput.name);
  push(toolInput.tool);
  push(toolInput.toolName);
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
