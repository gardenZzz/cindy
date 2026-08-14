/**
 * cursor-acp-mcp —— 本地 Cursor(ACP)会话的 lizi MCP 注入。
 *
 * cursor-agent 是独立子进程，消费不了 in-process McpServer instance；ACP 的
 * `session/new` / `session/load` 只接受 stdio / http / sse 形态（cursor 的
 * initialize 回 `mcpCapabilities: {http:true, sse:true}`）。因此走与远端 cc /
 * codex 完全相同的那座桥：`codexHttpBridge` 把 in-process server 暴露到
 * localhost，身份用 bearer token 鉴权 + URL query `?session=<id>` 路由 session
 * ctx。
 *
 * 与 cc-remote-mcp 的差异：本地无 SSH remote-forward（直接用 bridge 端口），
 * 也不需要注入代际指纹 —— cursor 每个 session 一个子进程，MCP 配置在
 * session/new 时冻入，不存在「attach 回旧配置的存活 query」。
 *
 * P1 #4 / #47：注入当前 bridge 上已启用的全量 lizi MCP（会话建立时快照）。
 * 本地 Cursor 使用 bridge **主 token（全通）**，不扩大远端 scoped
 * `REMOTE_ALLOWED_SERVER_NAMES` 白名单。协同两件套仍受 collab 全局开关约束。
 * 项目级禁用（workingDir）在建会话时冻结：既过滤下发名单，也写入 bridge
 * ctx 的 disabled snapshot，执行态与名单双重 fail-closed。
 *
 * 主 token 仍写进 ACP headers，但 `?session=` 请求必须同时命中
 * `registerSessionToken` 槽（codexHttpBridge 轮 24 TOCTOU：否则「ctx 已注册、
 * token 未注册」窗口里，任何持有主 token 的本地进程都能借任意 sessionId 绑
 * 定目标 ctx）。cleanup 与 Pi 一样成对注销 ctx + token（含代次）。
 */

import { getSessionOrcaRole, getWorkerLink } from '../localDb/orcaTeamStore.js';
import type { CodexHttpBridge } from '../mcp-integrations/codexHttpBridge.js';
import { REMOTE_COLLAB_SERVER_NAMES } from '../mcp-integrations/codexHttpBridge.js';
import { CODEX_DISABLED_BUILTIN_PLUGIN_IDS_KEY } from '../mcp-integrations/codexBuiltinToolPolicy.js';
import { pluginIdForProviderName } from './plugins/builtin-plugins.js';

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
  /**
   * 当前工作目录下已禁用的 runtime plugin id（会话建立时冻结）。
   * 缺省不按项目禁用过滤（测试可省略）。
   */
  getDisabledRuntimePluginIds?: (workingDir: string) => readonly string[];
  /**
   * 覆盖默认 token（测试用）。缺省用 bridge 主 token（全通），让本地 Cursor
   * 能访问全部已启用 lizi MCP，而不扩大远端 scoped token 白名单。
   */
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

/** 协同两件套与已知 provider → plugin id；未知 server 按 pluginIdForProviderName 透传。 */
export function cursorServerPluginId(serverName: string): string {
  if (REMOTE_COLLAB_SERVER_NAMES.has(serverName)) return 'collab';
  return pluginIdForProviderName(serverName);
}

/**
 * 从 bridge 当前名单选出本会话要冻入的 server 名。
 * collab 关时剥掉协同两件套；项目级 disabled 再剥对应 MCP。
 */
export function selectCursorInjectableServerNames(
  available: readonly string[],
  gates: { collabEnabled: boolean; disabledPluginIds?: readonly string[] },
): string[] {
  const disabled = new Set(gates.disabledPluginIds ?? []);
  return available.filter((name) => {
    if (!gates.collabEnabled && REMOTE_COLLAB_SERVER_NAMES.has(name)) return false;
    if (disabled.size === 0) return true;
    return !disabled.has(cursorServerPluginId(name));
  });
}

/**
 * 为一个本地 cursor 会话构建 ACP `mcpServers`。cleanup 必须在 session close
 * 时调用，成对注销 bridge 上的 session ctx 与 session token。
 *
 * 任何一环不可用（无 sessionId / bridge 未起 / 无可用 server / token 缺失）都
 * 返回空数组，会话照常起（可读降级，不阻断纯对话）。
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

  const started = await deps.ensureBridgeStarted();
  if (!started) return empty;

  const collabEnabled = deps.isCollabEnabled?.() !== false;
  const disabledPluginIds = deps.getDisabledRuntimePluginIds?.(args.workingDir) ?? [];
  const names = selectCursorInjectableServerNames(started.serverNames, {
    collabEnabled,
    disabledPluginIds,
  });
  if (names.length === 0) {
    started.bridge.unregisterSessionCtx(args.sessionId);
    started.bridge.unregisterSessionToken(args.sessionId);
    return empty;
  }

  // token 可用性必须在 register 之前确认：null 时下发 "Bearer null" 还会留下
  // 已注册 ctx（注册后失败无 cleanup 可达）。
  // 默认主 token：本地 Cursor 需要全量 lizi；测试可注入 scoped token 验证降级。
  const bridgeToken =
    deps.getBridgeToken !== undefined
      ? await deps.getBridgeToken()
      : started.bridge.token;
  if (!bridgeToken) return empty;

  const sessionId = args.sessionId;
  const synthesize = deps.synthesizeVendorOptions ?? synthesizeCursorOrcaVendorOptions;
  const baseVendor = args.vendorOptions ?? (await synthesize(sessionId));
  // 与 Codex thread ctx 同键：执行态 bridge 按冻结 snapshot 阻断已禁用 built-in。
  const vendorOptions: Record<string, unknown> = {
    ...baseVendor,
    [CODEX_DISABLED_BUILTIN_PLUGIN_IDS_KEY]: [...disabledPluginIds],
  };
  const ctx = {
    agentKind: 'cursor' as const,
    sessionId,
    workingDir: args.workingDir,
    // 创建方显式声明的 vendorOptions 优先：worker 首次创建时 DB 的 orca 标记
    // 发生在 bootstrap 之后，现场查库会拿到空角色把 worker 工具 fail-closed。
    vendorOptions,
    // caller provenance：不盖章 = orca_worker_bridge 的 authorizeSendToLeadCaller
    // 一律回 CALLER_PROVENANCE_REQUIRED，Cursor worker 永远回报不了 Lead。
    //
    // 只能盖 root：Cursor 的 subagent 与主循环共用同一个 ACP session 和同一条
    // MCP 连接，实测两者的 tools/call 除参数外完全一致（同 Mcp-Session-Id、同
    // `?session=` URL、都无 `params._meta`），子 agent 那次调用在 ACP 侧连
    // tool_call 都不发。没有任何 per-call 信号能分出 descendant。
    //
    // 代价（有意接受）：Codex 靠 `params._meta.threadId` 撑起的
    // NESTED_AGENT_NOT_ALLOWED 机制防线在 Cursor 上不存在，「子 agent 不得越级
    // 直报 Lead」只由 SEND_TO_LEAD_TOOL_DESCRIPTION 做 prompt 级约束。Cursor 若
    // 将来给 tool call 带上 thread / agent provenance，这里应改成按它分型。
    mcpCallerKind: 'root' as const,
    mcpCallerAttested: true,
  };
  started.bridge.registerSessionCtx(sessionId, ctx);
  // 主 token + ?session= 必须成对占 token 槽，否则 bridge 直接 401。
  let tokenGeneration: number | undefined;
  try {
    tokenGeneration = started.bridge.registerSessionToken(sessionId, bridgeToken);
  } catch (err) {
    started.bridge.unregisterSessionCtx(sessionId, ctx);
    throw err;
  }

  const dispose = () => {
    try {
      started.bridge.unregisterSessionCtx(sessionId, ctx);
    } finally {
      started.bridge.unregisterSessionToken(sessionId, bridgeToken, tokenGeneration);
    }
  };

  try {
    const servers = names.map((name) => ({
      type: 'http' as const,
      name,
      url: `http://127.0.0.1:${started.port}/mcp/${name}?session=${encodeURIComponent(sessionId)}`,
      headers: [{ name: 'Authorization', value: `Bearer ${bridgeToken}` }],
    }));
    return {
      servers,
      cleanup: dispose,
    };
  } catch (err) {
    dispose();
    throw err;
  }
}
