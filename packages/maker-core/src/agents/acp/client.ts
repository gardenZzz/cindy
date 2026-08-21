/**
 * ACP JSON-RPC 2.0 NDJSON client.
 *
 * 职责:
 *  - 接收 Transport factory (保证「先注册 handler 再启动」)
 *  - JSON-RPC 2.0 request/response 关联 (出站带 `"jsonrpc":"2.0"`)
 *  - ServerRequest → setRequestHandler; Notification → onNotification
 *  - close() 关 transport + reject 挂起 request
 *
 * 与 Codex AppServerClient 的差异:
 *  - ACP 带标准 jsonrpc 字段; Codex 走 jsonrpc_lite (无该字段)
 *  - 1 client = 1 transport = 1 进程; 无 thread 多路复用 (不要搬 host.ts)
 */

import type { Logger } from '../../interfaces/logger.js';
import {
  ACP_PROTOCOL_VERSION,
  JSONRPC_ERROR_CODE,
  JSONRPC_VERSION,
  Method,
  type ClientCapabilities,
  type ImplementationInfo,
  type IncomingMessage,
  type InitializeParams,
  type InitializeResponse,
  type JsonRpcErrorObject,
  type JsonRpcId,
} from './protocol.js';
import type { Transport } from './transport.js';

const DEFAULT_MAX_LINE_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_LOG_CHARS = 2_000;
// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC 是 ANSI escape 序列的协议字节。
const ANSI_ESCAPE_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g;

function normalizeStderrLine(line: string): string {
  if (line.length <= MAX_STDERR_LOG_CHARS) return line;
  const omitted = line.length - MAX_STDERR_LOG_CHARS;
  return `${line.slice(0, MAX_STDERR_LOG_CHARS)}... [truncated ${omitted} chars]`;
}

function classifyStderrLine(line: string): 'debug' | 'warn' | 'error' {
  const plain = line.replace(ANSI_ESCAPE_RE, '').trim();
  if (!plain) return 'debug';
  if (/\b(warn|warning)\b/i.test(plain)) return 'warn';
  if (
    /\b(error|fatal|panic|panicked|exception|unhandled|aborted|stack backtrace)\b/i.test(plain) ||
    /^error:/i.test(plain)
  ) {
    return 'error';
  }
  return 'debug';
}

function isJsonRpcRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** JSON-RPC error.data 里的可读真因；拿不到就 null（不塞 [object Object]）。 */
function errorDataDetail(data: unknown): string | null {
  if (typeof data === 'string') return data.trim() || null;
  if (isJsonRpcRecord(data) && typeof data.message === 'string') {
    return data.message.trim() || null;
  }
  return null;
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === 'string' || typeof value === 'number';
}

function isJsonRpcErrorObject(value: unknown): value is JsonRpcErrorObject {
  return (
    isJsonRpcRecord(value) &&
    typeof value.code === 'number' &&
    typeof value.message === 'string'
  );
}

/**
 * 严格运行时 record 校验：non-null 非数组对象，并对已出现的
 * id / method / error 做类型检查。不要求也不依赖 jsonrpc 字段
 * （ACP 有 `"jsonrpc":"2.0"`，codex app-server 走 jsonrpc_lite 无该字段）。
 */
export function asIncomingMessage(value: unknown): IncomingMessage | null {
  if (!isJsonRpcRecord(value)) return null;
  if ('id' in value && !isJsonRpcId(value.id)) return null;
  if ('method' in value && typeof value.method !== 'string') return null;
  if ('error' in value && !isJsonRpcErrorObject(value.error)) return null;
  return value as IncomingMessage;
}

export class AcpRequestTimeoutError extends Error {
  constructor(
    public readonly method: string,
    public readonly timeoutMs: number,
  ) {
    super(`acp ${method} timed out after ${timeoutMs}ms`);
    this.name = 'AcpRequestTimeoutError';
  }
}

export interface AcpClientOptions {
  /**
   * Transport 工厂; 在 start() 时调用一次。
   * factory 保证「register handlers → start transport」时序。
   */
  createTransport: () => Transport;
  logger: Logger;
  maxLineBytes?: number;
  onTransportError?: (err: Error) => void;
}

export type NotificationHandler = (params: unknown) => void | Promise<void>;
export type ServerRequestHandler = (
  params: unknown,
  meta: { id: JsonRpcId; method: string },
) => Promise<unknown>;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  method: string;
  timeoutId: ReturnType<typeof setTimeout> | null;
}

/**
 * 分流一条 ACP 入站消息的四形状判定结果。
 * 导出供单测用 fixture 显式覆盖 (含 `"jsonrpc":"2.0"` 字段时仍正确分流)。
 */
export type IncomingKind =
  | { kind: 'server_request'; id: JsonRpcId; method: string; params?: unknown }
  | { kind: 'response'; id: JsonRpcId; result: unknown }
  | { kind: 'error_response'; id: JsonRpcId; error: JsonRpcErrorObject }
  | { kind: 'notification'; method: string; params?: unknown }
  | { kind: 'unrecognized' };

export function classifyIncomingMessage(msg: IncomingMessage): IncomingKind {
  // 分流只看 id / method / result / error 是否存在; jsonrpc 字段不参与判定。
  if ('id' in msg && 'method' in msg) {
    return {
      kind: 'server_request',
      id: msg.id,
      method: msg.method,
      params: (msg as { params?: unknown }).params,
    };
  }
  if ('id' in msg && 'result' in msg) {
    return { kind: 'response', id: msg.id, result: msg.result };
  }
  if ('id' in msg && 'error' in msg) {
    return { kind: 'error_response', id: msg.id, error: msg.error };
  }
  if ('method' in msg) {
    return {
      kind: 'notification',
      method: msg.method,
      params: (msg as { params?: unknown }).params,
    };
  }
  return { kind: 'unrecognized' };
}

/** 单 session 单实例。1 client = 1 transport = 1 进程。 */
export class AcpClient {
  private readonly logger: Logger;
  private readonly maxLineBytes: number;
  private readonly onTransportError?: (err: Error) => void;

  private readonly createTransport: () => Transport;
  private transport: Transport | null = null;
  private started = false;

  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly notificationHandlers = new Map<string, NotificationHandler>();
  private readonly requestHandlers = new Map<string, ServerRequestHandler>();

  private initialized = false;
  private closed = false;

  constructor(opts: AcpClientOptions) {
    if (typeof opts.createTransport !== 'function') {
      throw new Error('AcpClient: createTransport factory is required');
    }
    this.createTransport = opts.createTransport;
    this.logger = opts.logger.child('acp');
    this.maxLineBytes = opts.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    this.onTransportError = opts.onTransportError;
  }

  /**
   * 启动 transport。必须在所有 onNotification / setRequestHandler 注册完毕之后调用一次。
   * 与 initialize() 的关系: 必须先 start() 后 initialize()。
   */
  start(): void {
    if (this.started) {
      throw new Error('AcpClient: already started');
    }
    if (this.closed) {
      throw new Error('AcpClient: cannot start after close()');
    }
    this.started = true;
    const transport = this.createTransport();
    this.transport = transport;
    transport.onLine((line) => this.safeTransportCallback('onLine', () => this.handleLine(line)));
    transport.onStderr?.((line) =>
      this.safeTransportCallback('onStderr', () => this.handleStderrLine(line)),
    );
    transport.onClose((info) =>
      this.safeTransportCallback('onClose', () => this.handleTransportClose(info.reason)),
    );
  }

  async initialize(opts?: {
    protocolVersion?: number;
    clientCapabilities?: ClientCapabilities;
    clientInfo?: ImplementationInfo | null;
  }): Promise<InitializeResponse> {
    if (!this.started) {
      throw new Error('AcpClient: must start() before initialize()');
    }
    if (this.closed) {
      throw new Error('AcpClient: cannot initialize after close()');
    }
    if (this.initialized) {
      throw new Error('AcpClient: already initialized');
    }
    const params: InitializeParams = {
      protocolVersion: opts?.protocolVersion ?? ACP_PROTOCOL_VERSION,
      clientCapabilities: opts?.clientCapabilities,
      clientInfo: opts?.clientInfo,
    };
    const response = await this.request<InitializeResponse>(Method.Initialize, params);
    this.initialized = true;
    this.logger.info('initialized', {
      protocolVersion: response.protocolVersion,
      loadSession: response.agentCapabilities?.loadSession,
      image: response.agentCapabilities?.promptCapabilities?.image,
      authMethods: (response.authMethods ?? []).map((m) => m.id),
    });
    return response;
  }

  async close(opts?: { reason?: string }): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const reason = opts?.reason ?? 'AcpClient.close()';

    const err = new Error(`acp closed: ${reason}`);
    for (const [, pending] of this.pending) {
      if (pending.timeoutId) clearTimeout(pending.timeoutId);
      pending.reject(err);
    }
    this.pending.clear();

    if (this.transport) {
      try {
        await this.transport.close(reason);
      } catch (e) {
        this.logger.warn('transport.close threw', { message: (e as Error).message });
      }
    }
  }

  /** 本地 stdio 子进程 pid；供孤儿核验。非本地 / 已关则为 null。 */
  getPid(): number | null {
    return this.transport?.getPid?.() ?? null;
  }

  /**
   * 发送 JSON-RPC request (带 `"jsonrpc":"2.0"`), 等待对应 id 的 response。
   */
  request<R = unknown>(
    method: string,
    params?: unknown,
    opts?: { timeoutMs?: number },
  ): Promise<R> {
    if (this.closed) {
      return Promise.reject(new Error(`AcpClient.request(${method}) after close()`));
    }
    if (!this.transport) {
      return Promise.reject(new Error(`AcpClient.request(${method}): not started`));
    }
    const transport = this.transport;
    const id = this.nextId++;
    const payload = JSON.stringify({
      jsonrpc: JSONRPC_VERSION,
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    });
    const timeoutMs = opts?.timeoutMs;
    if (
      timeoutMs !== undefined &&
      (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    ) {
      return Promise.reject(
        new Error(`AcpClient.request(${method}): timeoutMs must be a positive finite number`),
      );
    }
    return new Promise<R>((resolve, reject) => {
      const pending: PendingRequest = {
        resolve: resolve as (v: unknown) => void,
        reject,
        method,
        timeoutId: null,
      };
      this.pending.set(id, pending);
      if (timeoutMs !== undefined) {
        pending.timeoutId = setTimeout(() => {
          if (this.pending.get(id) !== pending) return;
          this.pending.delete(id);
          reject(new AcpRequestTimeoutError(method, timeoutMs));
        }, timeoutMs);
        pending.timeoutId.unref?.();
      }
      transport.writeLine(payload).then(undefined, (err: Error) => {
        if (this.pending.get(id) !== pending) return;
        this.pending.delete(id);
        if (pending.timeoutId) clearTimeout(pending.timeoutId);
        reject(err);
      });
    });
  }

  /** 发送 JSON-RPC notification (无 id, 不期待 response)。 */
  async notify(method: string, params?: unknown): Promise<void> {
    if (this.closed || !this.transport) {
      throw new Error(`AcpClient.notify(${method}) after close / not started`);
    }
    const payload = JSON.stringify({
      jsonrpc: JSONRPC_VERSION,
      method,
      ...(params !== undefined ? { params } : {}),
    });
    await this.transport.writeLine(payload);
  }

  onNotification(method: string, handler: NotificationHandler): void {
    if (this.notificationHandlers.has(method)) {
      this.logger.warn('overwriting notification handler', { method });
    }
    this.notificationHandlers.set(method, handler);
  }

  setRequestHandler(method: string, handler: ServerRequestHandler): void {
    if (this.requestHandlers.has(method)) {
      this.logger.warn('overwriting request handler', { method });
    }
    this.requestHandlers.set(method, handler);
  }

  private handleLine(line: string): void {
    if (!line) return;
    if (line.length > this.maxLineBytes) {
      const err = new Error(
        `acp NDJSON line exceeds maxLineBytes (${line.length} > ${this.maxLineBytes})`,
      );
      this.logger.error(err.message);
      this.handleTransportFailure(err);
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (e) {
      this.logger.warn('invalid JSON line', {
        message: (e as Error).message,
        preview: line.slice(0, 200),
      });
      return;
    }

    const msg = asIncomingMessage(parsed);
    if (!msg) {
      const err = new Error('acp invalid incoming message: expected a JSON-RPC record');
      this.logger.warn('invalid incoming message', {
        message: err.message,
        preview: line.slice(0, 200),
      });
      this.handleTransportFailure(err);
      return;
    }

    const classified = classifyIncomingMessage(msg);
    switch (classified.kind) {
      case 'server_request':
        void this.dispatchServerRequest(classified);
        return;
      case 'response':
        this.dispatchResponse(classified.id, classified.result, null);
        return;
      case 'error_response':
        this.dispatchResponse(classified.id, null, classified.error);
        return;
      case 'notification':
        void this.dispatchNotification(classified.method, classified.params);
        return;
      default:
        this.logger.warn('unrecognized incoming message', { preview: line.slice(0, 200) });
    }
  }

  /** 事件回调异常边界：绝不让异常从 transport 回调逃逸。 */
  private safeTransportCallback(label: string, fn: () => void): void {
    try {
      fn();
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      this.logger.error('transport callback threw', {
        label,
        message: err.message,
      });
      this.handleTransportFailure(err);
    }
  }

  private handleStderrLine(line: string): void {
    const logLine = normalizeStderrLine(line);
    const level = classifyStderrLine(line);
    this.logger[level]('stderr', { line: logLine });
  }

  private handleTransportClose(reason: string): void {
    const wasExternalClose = this.closed;
    this.logger.info('transport closed', { reason, wasExternalClose });
    if (wasExternalClose) return;
    this.handleTransportFailure(new Error(`acp transport closed: ${reason}`));
  }

  private dispatchResponse(id: JsonRpcId, result: unknown, error: JsonRpcErrorObject | null): void {
    const pending = this.pending.get(id);
    if (!pending) {
      this.logger.warn('response for unknown id', { id });
      return;
    }
    this.pending.delete(id);
    if (pending.timeoutId) clearTimeout(pending.timeoutId);
    if (error) {
      // Cursor 的真因只在 data.message（外层恒为 "Invalid params"）；不拼进来
      // 日志和 UI 就分不清模型不可用 / option 不存在 / session 丢失。
      const detail = errorDataDetail(error.data);
      const err = new Error(
        `acp ${pending.method} error ${error.code}: ${error.message}${detail ? ` (${detail})` : ''}`,
      );
      Object.assign(err, { code: error.code, data: error.data });
      pending.reject(err);
      return;
    }
    pending.resolve(result);
  }

  private async dispatchNotification(method: string, params: unknown): Promise<void> {
    const handler = this.notificationHandlers.get(method);
    if (!handler) {
      this.logger.debug('unhandled notification', { method });
      return;
    }
    try {
      await handler(params);
    } catch (e) {
      this.logger.error('notification handler threw', {
        method,
        message: (e as Error).message,
      });
    }
  }

  private async dispatchServerRequest(msg: {
    id: JsonRpcId;
    method: string;
    params?: unknown;
  }): Promise<void> {
    const handler = this.requestHandlers.get(msg.method);
    if (!handler) {
      this.sendErrorResponse(msg.id, {
        code: JSONRPC_ERROR_CODE.METHOD_NOT_FOUND,
        message: `no handler registered for ${msg.method}`,
      });
      return;
    }
    try {
      const result = await handler(msg.params, { id: msg.id, method: msg.method });
      this.sendSuccessResponse(msg.id, result);
    } catch (e) {
      const err = e as Error & { code?: number; data?: unknown };
      this.sendErrorResponse(msg.id, {
        code: typeof err.code === 'number' ? err.code : JSONRPC_ERROR_CODE.INTERNAL_ERROR,
        message: err.message,
        data: err.data,
      });
    }
  }

  private sendSuccessResponse(id: JsonRpcId, result: unknown): void {
    if (this.closed || !this.transport) return;
    const payload = JSON.stringify({
      jsonrpc: JSONRPC_VERSION,
      id,
      result: result ?? {},
    });
    this.transport.writeLine(payload).catch((err: Error) => {
      this.logger.warn('write success response failed', { id, message: err.message });
    });
  }

  private sendErrorResponse(id: JsonRpcId, error: JsonRpcErrorObject): void {
    if (this.closed || !this.transport) return;
    const payload = JSON.stringify({ jsonrpc: JSONRPC_VERSION, id, error });
    this.transport.writeLine(payload).catch((err: Error) => {
      this.logger.warn('write error response failed', { id, message: err.message });
    });
  }

  private handleTransportFailure(err: Error): void {
    if (this.onTransportError) {
      try {
        this.onTransportError(err);
      } catch (e) {
        this.logger.error('onTransportError handler threw', { message: (e as Error).message });
      }
    }
    void this.close({ reason: `transport failure: ${err.message}` });
  }
}
