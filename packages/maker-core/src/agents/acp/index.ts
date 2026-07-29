/**
 * ACP 标准面通用层 — 只实现协议传输 + 标准 session/update 翻译。
 * vendor 细节 (Cursor spawn args / capability 声明) 放在 agents/cursor/。
 */

export type {
  CloseHandler,
  LineHandler,
  StderrHandler,
  Transport,
  TransportCloseInfo,
} from './transport.js';

export {
  createAcpStdioTransport,
  type AcpStdioTransportOptions,
} from './stdioTransport.js';

export {
  AcpClient,
  AcpRequestTimeoutError,
  classifyIncomingMessage,
  type AcpClientOptions,
  type IncomingKind,
  type NotificationHandler,
  type ServerRequestHandler,
} from './client.js';

export {
  ACP_PROTOCOL_VERSION,
  JSONRPC_ERROR_CODE,
  JSONRPC_VERSION,
  Method,
  CursorMethod,
  type AgentCapabilities,
  type AgentMessageChunkUpdate,
  type AuthMethod,
  type ClientCapabilities,
  type ContentBlock,
  type ImplementationInfo,
  type IncomingMessage,
  type InitializeParams,
  type InitializeResponse,
  type JsonRpcErrorObject,
  type JsonRpcId,
  type NewSessionParams,
  type NewSessionResponse,
  type LoadSessionParams,
  type LoadSessionResponse,
  type AcpConfigOption,
  type AcpModelInfo,
  type AcpModelsState,
  type SetConfigOptionParams,
  type SetConfigOptionResult,
  type SetSessionModeParams,
  type CursorAcpModeId,
  type PermissionOption,
  type PermissionOptionKind,
  type PromptParams,
  type PromptResponse,
  type PromptUsage,
  type RequestPermissionParams,
  type RequestPermissionResult,
  type SessionUpdate,
  type SessionUpdateNotification,
  type StopReason,
  type ToolCallStatus,
  type ToolCallUpdate,
  type ToolKind,
  type UsageUpdate,
} from './protocol.js';

export {
  ACP_AUTO_ALLOW_KINDS,
  autoClassifierAllowsKind,
  cancelledPermissionResult,
  findPermissionOption,
  permissionToolCall,
  sessionAllowKeyFromSuggestion,
  sessionAllowKeyFromToolCall,
  toInteractionRequest,
  toRequestPermissionResult,
  toolInputFromAcpToolCall,
  toolNameFromAcpToolCall,
} from './permissions.js';

export {
  finishPromptTurn,
  ingestPromptUsage,
  newAcpRuntime,
  resetAcpTurn,
  translateAcpError,
  translateSessionUpdate,
  type AcpTranslateContext,
  type AcpTranslateRuntime,
  type AcpToolMeta,
} from './translator.js';
