/**
 * ACP (Agent Client Protocol) v1 — maker-core 实际用到的子集。
 *
 * 真值参考: agentclientprotocol/agent-client-protocol schema/v1 + docs/protocol/v1。
 * 与 Codex app-server 的关键差异: ACP 消息带标准 `"jsonrpc":"2.0"` 字段。
 *
 * 覆盖: initialize / session/new / session/prompt / session/cancel /
 * session/update (agent_message_chunk + usage_update + tool_call*) /
 * session/request_permission / session/set_config_option。
 * plan / resume 等留给后续票。
 */

export type JsonRpcId = number | string;

export const JSONRPC_VERSION = '2.0' as const;

export const JSONRPC_ERROR_CODE = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export type IncomingMessage =
  | { jsonrpc?: string; id: JsonRpcId; method: string; params?: unknown }
  | { jsonrpc?: string; id: JsonRpcId; result: unknown }
  | { jsonrpc?: string; id: JsonRpcId; error: JsonRpcErrorObject }
  | { jsonrpc?: string; method: string; params?: unknown };

export const Method = {
  Initialize: 'initialize',
  Authenticate: 'authenticate',
  SessionNew: 'session/new',
  SessionPrompt: 'session/prompt',
  SessionCancel: 'session/cancel',
  SessionUpdate: 'session/update',
  SessionRequestPermission: 'session/request_permission',
  /** Cursor / ACP 参数化配置（model / effort / fast / …）。 */
  SessionSetConfigOption: 'session/set_config_option',
} as const;

/** ACP protocolVersion integer — Cursor 实测协商为 1。 */
export const ACP_PROTOCOL_VERSION = 1;

export interface ImplementationInfo {
  name: string;
  title?: string;
  version: string;
}

export interface FileSystemCapabilities {
  readTextFile?: boolean;
  writeTextFile?: boolean;
}

/**
 * Client capabilities advertised in initialize.
 * `_meta.parameterizedModelPicker` 是 Cursor 扩展: 不声明则 variants 模型切换会静默失效。
 */
export interface ClientCapabilities {
  fs?: FileSystemCapabilities;
  terminal?: boolean;
  _meta?: {
    parameterizedModelPicker?: boolean;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface InitializeParams {
  protocolVersion: number;
  clientCapabilities?: ClientCapabilities;
  clientInfo?: ImplementationInfo | null;
}

export interface PromptCapabilities {
  image?: boolean;
  audio?: boolean;
  embeddedContext?: boolean;
}

export interface AgentCapabilities {
  loadSession?: boolean;
  promptCapabilities?: PromptCapabilities;
  mcpCapabilities?: Record<string, unknown>;
  sessionCapabilities?: Record<string, unknown>;
  auth?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface AuthMethod {
  id: string;
  name?: string;
  description?: string;
  type?: string;
}

export interface InitializeResponse {
  protocolVersion: number;
  agentCapabilities?: AgentCapabilities;
  authMethods?: AuthMethod[];
  agentInfo?: ImplementationInfo | null;
}

export interface NewSessionParams {
  cwd: string;
  mcpServers?: unknown[];
  additionalDirectories?: string[];
}

/** session/new.models — Cursor 实测形状。 */
export interface AcpModelInfo {
  modelId: string;
  name: string;
}

export interface AcpModelsState {
  currentModelId: string;
  availableModels: AcpModelInfo[];
}

/** session/set_config_option 返回的参数化选项（model / effort / fast / …）。 */
export interface AcpConfigOptionChoice {
  value: string;
  name: string;
  description?: string;
}

export interface AcpConfigOption {
  id: string;
  name: string;
  description?: string;
  category?: string;
  type?: string;
  currentValue: string;
  options: AcpConfigOptionChoice[];
}

export interface SetConfigOptionParams {
  sessionId: string;
  configId: string;
  value: string;
}

export interface SetConfigOptionResult {
  configOptions?: AcpConfigOption[];
  [key: string]: unknown;
}

export interface NewSessionResponse {
  sessionId: string;
  modes?: unknown;
  configOptions?: AcpConfigOption[] | unknown;
  models?: AcpModelsState | unknown;
  [key: string]: unknown;
}

export type StopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'max_turn_requests'
  | 'refusal'
  | 'cancelled';

/**
 * PromptResponse.usage — ACP RFD strawman (尚未进稳定 schema)。
 * Cursor 当前不返回; 预接字段, 缺省 / null = 无数据。
 */
export interface PromptUsage {
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  thoughtTokens?: number | null;
  cachedReadTokens?: number | null;
  cachedWriteTokens?: number | null;
}

export interface PromptResponse {
  stopReason: StopReason | string;
  usage?: PromptUsage | null;
}

export interface TextContentBlock {
  type: 'text';
  text: string;
  annotations?: unknown;
  _meta?: Record<string, unknown> | null;
}

export interface ImageContentBlock {
  type: 'image';
  data?: string;
  mimeType?: string;
  uri?: string;
  [key: string]: unknown;
}

export type ContentBlock = TextContentBlock | ImageContentBlock | { type: string; [key: string]: unknown };

export interface PromptParams {
  sessionId: string;
  prompt: ContentBlock[];
}

export interface SessionUpdateNotification {
  sessionId: string;
  update: SessionUpdate;
}

export type SessionUpdate =
  | AgentMessageChunkUpdate
  | UsageUpdate
  | ToolCallUpdate
  | { sessionUpdate: string; [key: string]: unknown };

export interface AgentMessageChunkUpdate {
  sessionUpdate: 'agent_message_chunk';
  content: ContentBlock;
  messageId?: string | null;
  _meta?: Record<string, unknown> | null;
}

/**
 * usage_update — session 级 context / cost。
 * Cursor 当前不发送; 预接, 缺省 = 无数据。
 */
export interface UsageUpdate {
  sessionUpdate: 'usage_update';
  used: number;
  size: number;
  cost?: { amount: number; currency: string } | null;
  _meta?: Record<string, unknown> | null;
}

/** ACP ToolKind — 帮助 UI / Auto 分类器选择处理方式。 */
export type ToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other'
  | string;

export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | string;

/**
 * tool_call / tool_call_update 共用字段。
 * v1 同时存在 `tool_call`(首报) 与 `tool_call_update`(补丁); Cursor 两者都发。
 */
export interface ToolCallUpdate {
  sessionUpdate: 'tool_call' | 'tool_call_update';
  toolCallId: string;
  title?: string | null;
  kind?: ToolKind | null;
  status?: ToolCallStatus | null;
  content?: unknown[] | null;
  locations?: unknown[] | null;
  rawInput?: unknown;
  rawOutput?: unknown;
  _meta?: Record<string, unknown> | null;
}

export type PermissionOptionKind =
  | 'allow_once'
  | 'allow_always'
  | 'reject_once'
  | 'reject_always'
  | string;

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: PermissionOptionKind;
  _meta?: Record<string, unknown> | null;
}

/**
 * session/request_permission params (ACP v1)。
 * Cursor 实测 options 为 allow-once / allow-always / reject-once。
 */
export interface RequestPermissionParams {
  sessionId: string;
  toolCall: ToolCallUpdate | Record<string, unknown>;
  options: PermissionOption[];
  _meta?: Record<string, unknown> | null;
}

export type RequestPermissionOutcome =
  | { outcome: 'cancelled' }
  | { outcome: 'selected'; optionId: string; _meta?: Record<string, unknown> | null }
  | { outcome: string; [key: string]: unknown };

export interface RequestPermissionResult {
  outcome: RequestPermissionOutcome;
  _meta?: Record<string, unknown> | null;
}
