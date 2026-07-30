/**
 * cursor-acp-mcp —— 本地 Cursor(ACP)会话的协同 MCP 注入。
 *
 * cursor-agent 是独立子进程，消费不了 in-process McpServer instance；ACP 的
 * `session/new` / `session/load` 只接受 stdio / http / sse 形态（cursor 的
 * initialize 回 `mcpCapabilities: {http:true, sse:true}`）。因此走与远端 cc /
 * codex 完全相同的那座桥：`codexHttpBridge` 把 in-process server 暴露到
 * localhost，身份用 persistent bearer token 鉴权 + URL query `?session=<id>`
 * 路由 session ctx（bridge 对 persistent token 的可达面已 scope 到协同 +
 * Maker Memory 白名单，见 codexHttpBridge 的 REMOTE_ALLOWED_SERVER_NAMES）。
 *
 * 与 cc-remote-mcp 的差异：本地无 SSH remote-forward（直接用 bridge 端口），
 * 也不需要注入代际指纹 —— cursor 每个 session 一个子进程，MCP 配置在
 * session/new 时冻入，不存在「attach 回旧配置的存活 query」。
 *
 * ponytail: 只注入协同两件套，不是全量 lizi MCP 桥（那是 P1 #4 的范围）。
 */

import { getSessionOrcaRole, getWorkerLink } from '../localDb/orcaTeamStore.js';
import type { CodexHttpBridge } from '../mcp-integrations/codexHttpBridge.js';
import { REMOTE_COLLAB_SERVER_NAMES } from '../mcp-integrations/codexHttpBridge.js';
import { getRemoteMcpBridgeToken } from '../mcp-integrations/remoteMcpBridgeToken.js';

/** ACP `mcpServers[]` 的 http 形态条目（agent-client-protocol HttpMcpServer）。 */
export interface AcpHttpMcpServer {
  type: 'http';
  name: string;
  url: string;
  headers: Array<{ name: string; value: string }>;
}

export interface CursorAcpMcpDeps {
  ensureBridgeStarted: () => Promise<{
    port: number;
    serverNames: string[];
    bridge: CodexHttpBridge;
  } | null>;
  /** collab 全局开关（plugin registry Tier 4）。缺省视为开启。 */
  isCollabEnabled?: () => boolean;
  /** persistent bridge token；测试注入 stub。null = 不可用 → 不注入。 */
  getBridgeToken?: () => Promise<string | null> | string | null;
  /** vendorOptions 缺失时按 DB 合成 orca 角色（与 cc-remote 同语义）。 */
  synthesizeVendorOptions?: (sessionId: string) => Promise<Record<string, unknown>>;
}

/**
 * vendorOptions 缺失时按 DB 合成 orca 身份。与
 * maker-ipc/orcaSessionStartOptions.synthesizeOrcaVendorOptionsFromDb 同语义，
 * 但 maker-host 不反向依赖 maker-ipc。
 */
export async function synthesizeCursorOrcaVendorOptions(
  sessionId: string,
): Promise<Record<string, unknown>> {
  try {
    const role = await getSessionOrcaRole(sessionId);
    if (role === 'lead') {
      return { orcaRole: 'lead', orcaLeadSessionId: sessionId };
    }
    if (role === 'worker') {
      const link = await getWorkerLink({ workerSessionId: sessionId });
      if (link) {
        return {
          orcaRole: 'worker',
          orcaWorkflowId: link.teamId,
          orcaLeadSessionId: link.leadSessionId,
          orcaWorkerId: link.workerId,
          orcaWorkerSessionId: sessionId,
        };
      }
    }
  } catch {
    // 非 orca session 或 DB 未就绪：空 vendorOptions，控制类工具按无角色拒绝。
  }
  return {};
}

/**
 * 为一个本地 cursor 会话构建 ACP `mcpServers`。cleanup 必须在 session close
 * 时调用，注销 bridge 上的 session ctx。
 *
 * 任何一环不可用（无 sessionId / bridge 未起 / collab 关 / token 缺失）都返回
 * 空数组，会话照常起，只是没有协同工具面。
 */
export async function buildCursorAcpMcpServers(
  args: {
    sessionId?: string;
    workingDir: string;
    vendorOptions?: Record<string, unknown>;
  },
  deps: CursorAcpMcpDeps,
): Promise<{ servers: AcpHttpMcpServer[]; cleanup?: () => void }> {
  const empty = { servers: [] as AcpHttpMcpServer[] };
  // ?session= 是唯一身份通道：没有业务 session id 就无法路由 ctx，注入了也只会
  // 让工具在 NO_SESSION_CONTEXT 上打转。
  if (!args.sessionId) return empty;
  if (deps.isCollabEnabled?.() === false) return empty;

  const started = await deps.ensureBridgeStarted();
  if (!started) return empty;
  const names = started.serverNames.filter((name) => REMOTE_COLLAB_SERVER_NAMES.has(name));
  if (names.length === 0) {
    started.bridge.unregisterSessionCtx(args.sessionId);
    return empty;
  }

  // token 可用性必须在 register 之前确认：null 时下发 "Bearer null" 还会留下
  // 已注册 ctx（注册后失败无 cleanup 可达）。
  const bridgeToken = await (deps.getBridgeToken ?? getRemoteMcpBridgeToken)();
  if (!bridgeToken) return empty;

  const sessionId = args.sessionId;
  const synthesize = deps.synthesizeVendorOptions ?? synthesizeCursorOrcaVendorOptions;
  const ctx = {
    agentKind: 'cursor' as const,
    sessionId,
    workingDir: args.workingDir,
    // 创建方显式声明的 vendorOptions 优先：worker 首次创建时 DB 的 orca 标记
    // 发生在 bootstrap 之后，现场查库会拿到空角色把 worker 工具 fail-closed。
    vendorOptions: args.vendorOptions ?? (await synthesize(sessionId)),
  };
  started.bridge.registerSessionCtx(sessionId, ctx);
  try {
    const servers = names.map((name) => ({
      type: 'http' as const,
      name,
      url: `http://127.0.0.1:${started.port}/mcp/${name}?session=${encodeURIComponent(sessionId)}`,
      headers: [{ name: 'Authorization', value: `Bearer ${bridgeToken}` }],
    }));
    return {
      servers,
      cleanup: () => started.bridge.unregisterSessionCtx(sessionId, ctx),
    };
  } catch (err) {
    started.bridge.unregisterSessionCtx(sessionId, ctx);
    throw err;
  }
}
