/**
 * CursorAgent 的 MCP 注入：host 的 prepareAcpMcpServers 结果必须原样进
 * session/new（以及 resume 的 session/load）的 mcpServers，close 时跑 cleanup；
 * host 未接线 / 抛错时按「无 MCP」降级，不阻断会话。
 */

import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CursorAgent } from './index.js';
import { createConsoleLogger } from '../../interfaces/logger.js';
import type { AuthAdapter } from '../../interfaces/auth-adapter.js';
import type { AgentDeps } from '../base-agent.js';
import type { CloseHandler, LineHandler, StderrHandler, Transport } from '../acp/transport.js';
import { JSONRPC_VERSION, Method } from '../acp/protocol.js';

class FakeTransport implements Transport {
  readonly written: Array<Record<string, unknown>> = [];
  private readonly lineHandlers = new Set<LineHandler>();
  private readonly closeHandlers = new Set<CloseHandler>();
  private closed = false;

  async writeLine(line: string): Promise<void> {
    const msg = JSON.parse(line) as Record<string, unknown>;
    this.written.push(msg);
    if (typeof msg.id !== 'number' && typeof msg.id !== 'string') return;
    if (msg.method === Method.Initialize) {
      queueMicrotask(() =>
        this.emit({
          jsonrpc: JSONRPC_VERSION,
          id: msg.id,
          result: {
            protocolVersion: 1,
            agentCapabilities: { loadSession: true, mcpCapabilities: { http: true, sse: true } },
            authMethods: [],
          },
        }),
      );
      return;
    }
    if (msg.method === Method.SessionNew) {
      queueMicrotask(() =>
        this.emit({
          jsonrpc: JSONRPC_VERSION,
          id: msg.id,
          result: {
            sessionId: 'sess-mcp',
            models: {
              currentModelId: 'default',
              availableModels: [{ modelId: 'default', name: 'Auto' }],
            },
          },
        }),
      );
      return;
    }
    if (msg.method === Method.SessionSetConfigOption || msg.method === Method.SessionSetMode) {
      queueMicrotask(() => this.emit({ jsonrpc: JSONRPC_VERSION, id: msg.id, result: {} }));
    }
  }
  onLine(handler: LineHandler): () => void {
    this.lineHandlers.add(handler);
    return () => this.lineHandlers.delete(handler);
  }
  onStderr(_handler: StderrHandler): () => void {
    return () => undefined;
  }
  onClose(handler: CloseHandler): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }
  getPid(): number | null {
    return this.closed ? null : 5150;
  }
  async close(reason = 'fake close'): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const h of this.closeHandlers) h({ reason });
  }
  emit(value: unknown): void {
    for (const h of this.lineHandlers) h(JSON.stringify(value));
  }
  findRequest(method: string): Record<string, unknown> | undefined {
    return this.written.find((m) => m.method === method)?.params as
      | Record<string, unknown>
      | undefined;
  }
}

function authStub(): AuthAdapter {
  return {
    getState: async () => ({ authenticated: true }),
    triggerLogin: async () => ({ authenticated: true }),
    logout: async () => undefined,
    getAuthEnv: async () => ({}),
  };
}

async function boot(
  transport: FakeTransport,
  prepareAcpMcpServers?: AgentDeps['prepareAcpMcpServers'],
) {
  const userDataPath = mkdtempSync(join(tmpdir(), 'cindy-cursor-mcp-'));
  const agent = new CursorAgent({
    auth: authStub(),
    runtimeConfig: { userDataPath },
    binaryPath: '/dev/null/cursor-agent',
    logger: createConsoleLogger('cursor-mcp'),
    networkConfigReader: () => undefined,
    accountIdentityReader: () => undefined,
    ...(prepareAcpMcpServers ? { prepareAcpMcpServers } : {}),
  });
  const handle = await agent.startSession({
    sessionId: 'biz-1',
    workingDir: '/tmp',
    model: 'default',
    vendorOptions: { createAcpTransport: () => transport, orcaRole: 'worker' },
  });
  await handle.bootstrapReady;
  const prevClose = handle.close.bind(handle);
  handle.close = async () => {
    try {
      await prevClose();
    } finally {
      await agent.dispose().catch(() => undefined);
      rmSync(userDataPath, { recursive: true, force: true });
    }
  };
  return handle;
}

const ORCA_SERVER = {
  type: 'http',
  name: 'cindy_orca',
  url: 'http://127.0.0.1:38080/mcp/cindy_orca?session=biz-1',
  headers: [{ name: 'Authorization', value: 'Bearer tok' }],
};

describe('CursorAgent ACP MCP injection', () => {
  it('passes the host-prepared servers into session/new and runs cleanup on close', async () => {
    const transport = new FakeTransport();
    const cleanup = vi.fn();
    const prepare = vi.fn(async () => ({ servers: [ORCA_SERVER], cleanup }));
    const handle = await boot(transport, prepare);

    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'biz-1',
        workingDir: '/tmp',
        vendorOptions: expect.objectContaining({ orcaRole: 'worker' }),
      }),
    );
    expect(transport.findRequest(Method.SessionNew)?.mcpServers).toEqual([ORCA_SERVER]);

    expect(cleanup).not.toHaveBeenCalled();
    await handle.close();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('starts the session with no MCP when the host hook is absent', async () => {
    const transport = new FakeTransport();
    const handle = await boot(transport);
    expect(transport.findRequest(Method.SessionNew)?.mcpServers).toEqual([]);
    await handle.close();
  });

  it('degrades to no MCP when the host hook throws', async () => {
    const transport = new FakeTransport();
    const handle = await boot(transport, async () => {
      throw new Error('bridge down');
    });
    expect(transport.findRequest(Method.SessionNew)?.mcpServers).toEqual([]);
    await handle.close();
  });

  it('setVendorOptions mutates the same vendorOptions object passed to prepareAcpMcpServers', async () => {
    // enableOrca → setLeadVendorOptions 依赖 in-place 合并；否则 bridge ctx 永远读不到 orcaRole。
    const transport = new FakeTransport();
    let capturedVo: Record<string, unknown> | undefined;
    const prepare = vi.fn(async (args: { vendorOptions?: Record<string, unknown> }) => {
      capturedVo = args.vendorOptions as Record<string, unknown>;
      return { servers: [ORCA_SERVER] };
    });
    const handle = await boot(transport, prepare);
    expect(capturedVo).toBeDefined();
    expect(capturedVo?.orcaRole).toBe('worker');

    await handle.setVendorOptions?.({
      orcaRole: 'lead',
      orcaWorkflowId: 'team-1',
      orcaLeadSessionId: 'biz-1',
    });
    expect(capturedVo).toMatchObject({
      orcaRole: 'lead',
      orcaWorkflowId: 'team-1',
      orcaLeadSessionId: 'biz-1',
    });
    await handle.close();
  });
});
