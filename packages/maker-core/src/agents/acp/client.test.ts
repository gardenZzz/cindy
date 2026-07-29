import { describe, expect, it, vi } from 'vitest';

import {
  AcpClient,
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
