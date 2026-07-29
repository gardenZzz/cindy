import { describe, expect, it, vi } from 'vitest';

import {
  AcpClient,
  asIncomingMessage,
  classifyIncomingMessage,
} from './client.js';
import { JSONRPC_VERSION } from './protocol.js';
import type { Logger } from '../../interfaces/logger.js';
import type { CloseHandler, LineHandler, StderrHandler, Transport } from './transport.js';

class FakeTransport implements Transport {
  readonly lines: string[] = [];
  private readonly lineHandlers = new Set<LineHandler>();
  private readonly stderrHandlers = new Set<StderrHandler>();
  private readonly closeHandlers = new Set<CloseHandler>();

  async writeLine(line: string): Promise<void> {
    this.lines.push(line);
  }

  onLine(handler: LineHandler): () => void {
    this.lineHandlers.add(handler);
    return () => this.lineHandlers.delete(handler);
  }

  onClose(handler: CloseHandler): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  onStderr(handler: StderrHandler): () => void {
    this.stderrHandlers.add(handler);
    return () => this.stderrHandlers.delete(handler);
  }

  async close(reason = 'test close'): Promise<void> {
    for (const handler of this.closeHandlers) handler({ reason });
  }

  emitLine(value: unknown): void {
    const line = typeof value === 'string' ? value : JSON.stringify(value);
    for (const handler of this.lineHandlers) handler(line);
  }
}

const logger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: () => logger,
};

/**
 * ACP 四形状 fixture — 每条都带标准 `"jsonrpc":"2.0"`。
 * 分流只看 id/method/result/error; 多一个 jsonrpc 字段不得改变判定。
 */
const ACP_FOUR_SHAPES = {
  serverRequest: {
    jsonrpc: JSONRPC_VERSION,
    id: 42,
    method: 'session/request_permission',
    params: { sessionId: 's1', toolCall: { toolCallId: 't1' } },
  },
  successResponse: {
    jsonrpc: JSONRPC_VERSION,
    id: 1,
    result: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
  },
  errorResponse: {
    jsonrpc: JSONRPC_VERSION,
    id: 2,
    error: { code: -32600, message: 'Invalid Request' },
  },
  notification: {
    jsonrpc: JSONRPC_VERSION,
    method: 'session/update',
    params: {
      sessionId: 's1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hi' },
      },
    },
  },
} as const;

describe('classifyIncomingMessage (ACP jsonrpc 2.0 four shapes)', () => {
  it('classifies id+method as server_request', () => {
    expect(classifyIncomingMessage(ACP_FOUR_SHAPES.serverRequest)).toEqual({
      kind: 'server_request',
      id: 42,
      method: 'session/request_permission',
      params: ACP_FOUR_SHAPES.serverRequest.params,
    });
  });

  it('classifies id+result as response', () => {
    expect(classifyIncomingMessage(ACP_FOUR_SHAPES.successResponse)).toEqual({
      kind: 'response',
      id: 1,
      result: ACP_FOUR_SHAPES.successResponse.result,
    });
  });

  it('classifies id+error as error_response', () => {
    expect(classifyIncomingMessage(ACP_FOUR_SHAPES.errorResponse)).toEqual({
      kind: 'error_response',
      id: 2,
      error: ACP_FOUR_SHAPES.errorResponse.error,
    });
  });

  it('classifies method-only as notification', () => {
    expect(classifyIncomingMessage(ACP_FOUR_SHAPES.notification)).toEqual({
      kind: 'notification',
      method: 'session/update',
      params: ACP_FOUR_SHAPES.notification.params,
    });
  });

  it('matches the same shapes without a jsonrpc field (jsonrpc_lite parity)', () => {
    expect(
      classifyIncomingMessage({ id: 1, method: 'fs/read_text_file', params: {} }),
    ).toMatchObject({ kind: 'server_request' });
    expect(classifyIncomingMessage({ id: 1, result: {} })).toMatchObject({ kind: 'response' });
    expect(
      classifyIncomingMessage({ id: 1, error: { code: -1, message: 'x' } }),
    ).toMatchObject({ kind: 'error_response' });
    expect(classifyIncomingMessage({ method: 'session/update' })).toMatchObject({
      kind: 'notification',
    });
  });
});

describe('asIncomingMessage (runtime record guard)', () => {
  it('accepts the four well-formed shapes', () => {
    expect(asIncomingMessage(ACP_FOUR_SHAPES.serverRequest)).not.toBeNull();
    expect(asIncomingMessage(ACP_FOUR_SHAPES.successResponse)).not.toBeNull();
    expect(asIncomingMessage(ACP_FOUR_SHAPES.errorResponse)).not.toBeNull();
    expect(asIncomingMessage(ACP_FOUR_SHAPES.notification)).not.toBeNull();
  });

  it('rejects non-object JSON values', () => {
    expect(asIncomingMessage(null)).toBeNull();
    expect(asIncomingMessage('banner')).toBeNull();
    expect(asIncomingMessage(42)).toBeNull();
    expect(asIncomingMessage(true)).toBeNull();
    expect(asIncomingMessage([])).toBeNull();
  });

  it('rejects present fields with wrong types', () => {
    expect(asIncomingMessage({ id: {}, result: {} })).toBeNull();
    expect(asIncomingMessage({ id: 1, method: 42 })).toBeNull();
    expect(asIncomingMessage({ id: 1, error: 'oops' })).toBeNull();
    expect(asIncomingMessage({ id: 1, error: { code: 'x', message: 1 } })).toBeNull();
  });
});

describe('AcpClient invalid incoming lines (controlled path)', () => {
  function startClient() {
    const transport = new FakeTransport();
    const onTransportError = vi.fn();
    const client = new AcpClient({
      createTransport: () => transport,
      logger,
      onTransportError,
    });
    client.start();
    return { transport, client, onTransportError };
  }

  it.each([
    ['null', 'null'],
    ['string', '"banner"'],
    ['number', '42'],
    ['boolean', 'true'],
    ['array', '[]'],
    ['id object', JSON.stringify({ id: { nested: true }, result: {} })],
    ['method number', JSON.stringify({ id: 1, method: 99 })],
    ['bad error', JSON.stringify({ id: 1, error: { code: 'x', message: 1 } })],
  ] as const)('does not throw on %s and fails transport', (_label, line) => {
    vi.mocked(logger.warn).mockClear();
    const { transport, onTransportError } = startClient();

    expect(() => transport.emitLine(line)).not.toThrow();
    expect(logger.warn).toHaveBeenCalledWith(
      'invalid incoming message',
      expect.objectContaining({ preview: expect.any(String) }),
    );
    expect(onTransportError).toHaveBeenCalledTimes(1);
    expect(onTransportError.mock.calls[0]?.[0]).toMatchObject({
      message: expect.stringContaining('invalid incoming message'),
    });
  });
});

describe('AcpClient message dispatch with jsonrpc fixtures', () => {
  it('pairs success responses that carry jsonrpc:2.0', async () => {
    const transport = new FakeTransport();
    const client = new AcpClient({ createTransport: () => transport, logger });
    client.start();

    const pending = client.request('initialize', { protocolVersion: 1 });
    expect(JSON.parse(transport.lines[0] ?? '')).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
    });

    transport.emitLine(ACP_FOUR_SHAPES.successResponse);
    await expect(pending).resolves.toEqual(ACP_FOUR_SHAPES.successResponse.result);
  });

  it('rejects error responses that carry jsonrpc:2.0', async () => {
    const transport = new FakeTransport();
    const client = new AcpClient({ createTransport: () => transport, logger });
    client.start();

    const pending = client.request('session/prompt', { sessionId: 's', prompt: [] });
    transport.emitLine({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32600, message: 'Invalid Request' },
    });
    await expect(pending).rejects.toThrow(/Invalid Request/);
  });

  it('routes session/update notifications with jsonrpc:2.0', async () => {
    const transport = new FakeTransport();
    const client = new AcpClient({ createTransport: () => transport, logger });
    const handler = vi.fn();
    client.onNotification('session/update', handler);
    client.start();

    transport.emitLine(ACP_FOUR_SHAPES.notification);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    expect(handler).toHaveBeenCalledWith(ACP_FOUR_SHAPES.notification.params);
  });

  it('answers server requests and includes jsonrpc on the response', async () => {
    const transport = new FakeTransport();
    const client = new AcpClient({ createTransport: () => transport, logger });
    const handler = vi.fn(async () => ({ outcome: { outcome: 'allow_once' } }));
    client.setRequestHandler('session/request_permission', handler);
    client.start();

    transport.emitLine(ACP_FOUR_SHAPES.serverRequest);
    await vi.waitFor(() => expect(transport.lines.length).toBe(1));
    expect(JSON.parse(transport.lines[0] ?? '')).toEqual({
      jsonrpc: '2.0',
      id: 42,
      result: { outcome: { outcome: 'allow_once' } },
    });
  });

  it('initialize advertises parameterizedModelPicker in clientCapabilities._meta', async () => {
    const transport = new FakeTransport();
    const client = new AcpClient({ createTransport: () => transport, logger });
    client.start();

    const pending = client.initialize({
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        _meta: { parameterizedModelPicker: true },
      },
      clientInfo: { name: 'cindy', version: '0.0.0' },
    });
    const sent = JSON.parse(transport.lines[0] ?? '');
    expect(sent.params.clientCapabilities._meta.parameterizedModelPicker).toBe(true);

    transport.emitLine({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: 1,
        agentCapabilities: { promptCapabilities: { image: true } },
        authMethods: [{ id: 'cursor_login' }],
      },
    });
    const result = await pending;
    expect(result.protocolVersion).toBe(1);
  });
});
