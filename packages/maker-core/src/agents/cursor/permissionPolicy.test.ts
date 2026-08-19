/**
 * Cursor permission-mode + ACP outcome policy unit tests.
 */

import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createConsoleLogger } from '../../interfaces/logger.js';
import type { AuthAdapter } from '../../interfaces/auth-adapter.js';
import type { InteractionDecision, InteractionRequest } from '../../types/events.js';
import { CursorAgent } from './index.js';
import type { Transport, LineHandler, CloseHandler, StderrHandler } from '../acp/transport.js';
import { AcpClient } from '../acp/client.js';
import {
  classifyAcpAutoPermission,
  sessionAllowKeyFromToolCall,
  toInteractionRequest,
  toRequestPermissionResult,
} from '../acp/permissions.js';
import { JSONRPC_VERSION, Method, type PermissionOption } from '../acp/protocol.js';

const OPTIONS: PermissionOption[] = [
  { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
  { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
];

type ClassifyAutoPermission = NonNullable<
  ConstructorParameters<typeof CursorAgent>[0]['classifyAutoPermission']
>;

function createAuthStub(): AuthAdapter {
  return {
    getState: async () => ({ authenticated: true }),
    triggerLogin: async () => ({ authenticated: true }),
    logout: async () => undefined,
    getAuthEnv: async () => ({}),
  };
}

class FakeTransport implements Transport {
  lines: string[] = [];
  written: unknown[] = [];
  private lineHandler: LineHandler | null = null;
  private closeHandler: CloseHandler | null = null;

  async writeLine(line: string): Promise<void> {
    this.lines.push(line);
    this.written.push(JSON.parse(line));
  }
  onLine(handler: LineHandler): () => void {
    this.lineHandler = handler;
    return () => {
      if (this.lineHandler === handler) this.lineHandler = null;
    };
  }
  onStderr(_handler: StderrHandler): () => void {
    return () => undefined;
  }
  onClose(handler: CloseHandler): () => void {
    this.closeHandler = handler;
    return () => {
      if (this.closeHandler === handler) this.closeHandler = null;
    };
  }
  async close(): Promise<void> {
    this.closeHandler?.({ reason: 'test' });
  }
  emitLine(msg: unknown): void {
    this.lineHandler?.(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  findResponse(id: number | string): unknown {
    for (const msg of this.written) {
      if (
        typeof msg === 'object' &&
        msg !== null &&
        'id' in msg &&
        (msg as { id: unknown }).id === id &&
        'result' in msg
      ) {
        return (msg as { result: unknown }).result;
      }
    }
    return undefined;
  }
}

async function bootCursorSession(args: {
  transport: FakeTransport;
  classifyAutoPermission?: ClassifyAutoPermission;
  onAutoPermissionClassifierUnavailable?: (a: {
    sessionId: string;
    agentKind: string;
    status: number;
  }) => void;
  permissionMode?: 'ask' | 'auto' | 'bypassPermissions';
  prepareAcpMcpServers?: ConstructorParameters<typeof CursorAgent>[0]['prepareAcpMcpServers'];
  getMcpToolApprovalPolicy?: ConstructorParameters<typeof CursorAgent>[0]['getMcpToolApprovalPolicy'];
  interactionResolver?: (req: InteractionRequest) => Promise<InteractionDecision>;
}) {
  const userDataPath = mkdtempSync(join(tmpdir(), 'cindy-cursor-perm-'));
  const agent = new CursorAgent({
    auth: createAuthStub(),
    runtimeConfig: { userDataPath },
    binaryPath: '/tmp/fake-cursor-agent',
    logger: createConsoleLogger('cursor-perm-test'),
    networkConfigReader: () => undefined,
    accountIdentityReader: () => undefined,
    classifyAutoPermission: args.classifyAutoPermission,
    onAutoPermissionClassifierUnavailable: args.onAutoPermissionClassifierUnavailable,
    prepareAcpMcpServers: args.prepareAcpMcpServers,
    getMcpToolApprovalPolicy: args.getMcpToolApprovalPolicy,
  });

  const origWrite = args.transport.writeLine.bind(args.transport);
  args.transport.writeLine = async (line: string) => {
    await origWrite(line);
    const msg = JSON.parse(line) as Record<string, unknown>;
    if (typeof msg.id !== 'number' && typeof msg.id !== 'string') return;
    if (msg.method === Method.Initialize) {
      queueMicrotask(() =>
        args.transport.emitLine({
          jsonrpc: JSONRPC_VERSION,
          id: msg.id,
          result: {
            protocolVersion: 1,
            agentCapabilities: { loadSession: true },
            authMethods: [],
          },
        }),
      );
      return;
    }
    if (msg.method === Method.SessionNew) {
      queueMicrotask(() =>
        args.transport.emitLine({
          jsonrpc: JSONRPC_VERSION,
          id: msg.id,
          result: {
            sessionId: 'sess-perm',
            models: {
              currentModelId: 'default',
              availableModels: [{ modelId: 'default', name: 'Auto' }],
            },
          },
        }),
      );
    }
  };

  try {
    const handle = await agent.startSession({
      workingDir: '/tmp',
      model: 'default',
      sessionId: 'biz-session-perm',
      permissionMode: args.permissionMode ?? 'auto',
      vendorOptions: { createAcpTransport: () => args.transport },
    });
    await handle.bootstrapReady;
    if (args.interactionResolver) {
      handle.setInteractionResolver(async (req) => {
        if (req.kind !== 'permission') {
          return { kind: 'permission', behavior: 'deny' };
        }
        return args.interactionResolver!(req);
      });
    }
    const prevClose = handle.close.bind(handle);
    handle.close = async () => {
      try {
        await prevClose();
      } finally {
        await agent.dispose().catch(() => undefined);
        rmSync(userDataPath, { recursive: true, force: true });
      }
    };
    return { agent, handle };
  } catch (err) {
    rmSync(userDataPath, { recursive: true, force: true });
    throw err;
  }
}

describe('CursorAgent capabilities — permission modes', () => {
  it('declares ask / auto / bypassPermissions and mid-session switch', () => {
    const agent = new CursorAgent({
      auth: createAuthStub(),
      runtimeConfig: {},
      binaryPath: '/tmp/fake-cursor-agent',
      logger: createConsoleLogger('cursor-perm-test'),
      networkConfigReader: () => undefined,
    accountIdentityReader: () => undefined,
    });
    const ids = agent.capabilities.permissionModes.map((p) => p.id);
    expect(ids).toEqual(['ask', 'auto', 'bypassPermissions']);
    expect(agent.capabilities.setPermissionModeMidSession).toEqual({ supported: true });
    expect(agent.capabilities.planMode).toEqual({ supported: true });
  });
});

describe('Cursor permission policy outcomes (client strategy)', () => {
  it('Full / session-grant resolve to allow-once and never allow-always', () => {
    const allow = toRequestPermissionResult(
      { kind: 'permission', behavior: 'allow' },
      OPTIONS,
    );
    expect(allow.outcome).toEqual({ outcome: 'selected', optionId: 'allow-once' });

    const sessionGrant = toRequestPermissionResult(
      {
        kind: 'permission',
        behavior: 'allow',
        permissionUpdates: [{ destination: 'session', sessionAllowKey: 'execute:ls' }],
      },
      OPTIONS,
    );
    expect(JSON.stringify(sessionGrant)).not.toContain('allow-always');
    expect(sessionGrant.outcome).toEqual({ outcome: 'selected', optionId: 'allow-once' });
  });

  it('Auto classifier asks for sensitive paths even when kind is read', () => {
    // 替换旧断言 read=true：kind 白名单不够，必须看 path。
    expect(
      classifyAcpAutoPermission({
        toolName: 'read',
        input: { path: '~/.ssh/id_rsa' },
        kind: 'read',
      }),
    ).toBe('ask');
    expect(
      classifyAcpAutoPermission({
        toolName: 'exec',
        input: { command: 'ls' },
        kind: 'execute',
      }),
    ).toBe('ask');
    expect(
      classifyAcpAutoPermission({
        toolName: 'read',
        input: { path: 'README.md' },
        kind: 'read',
      }),
    ).toBe('allow');
  });

  it('InteractionRequest carries sessionAllowKey for Cindy-layer memory', () => {
    const toolCall = {
      toolCallId: 't1',
      kind: 'execute' as const,
      title: '`rm -rf /`',
      rawInput: { command: 'rm -rf /' },
    };
    // 完整命令行：按 argv0 归并的话，批准过任意一条 `rm` 就等于给 `rm -rf /` 发了通行证。
    expect(sessionAllowKeyFromToolCall(toolCall)).toBe('execute:rm -rf /');
    const req = toInteractionRequest({
      requestId: 'r1',
      params: { sessionId: 's', toolCall, options: OPTIONS },
      suggestions: [
        { destination: 'session', sessionAllowKey: sessionAllowKeyFromToolCall(toolCall) },
      ],
    });
    expect(req.kind).toBe('permission');
    if (req.kind === 'permission') {
      expect(req.suggestions).toEqual([
        { destination: 'session', sessionAllowKey: 'execute:rm -rf /' },
      ]);
    }
  });
});

describe('CursorAgent Auto classifier injection', () => {
  async function emitPermission(
    transport: FakeTransport,
    toolCall: Record<string, unknown>,
    id = 7,
  ): Promise<unknown> {
    transport.emitLine({
      jsonrpc: '2.0',
      id,
      method: Method.SessionRequestPermission,
      params: {
        sessionId: 'sess-perm',
        toolCall,
        options: OPTIONS,
      },
    });
    await vi.waitFor(() => expect(transport.findResponse(id)).toBeDefined());
    return transport.findResponse(id);
  }

  it('asks (does not silent-allow) when reading ssh private key under Auto', async () => {
    const transport = new FakeTransport();
    const seen: InteractionRequest[] = [];
    await bootCursorSession({
      transport,
      permissionMode: 'auto',
      classifyAutoPermission: async (args) => classifyAcpAutoPermission(args),
      interactionResolver: async (req) => {
        seen.push(req);
        return { kind: 'permission', behavior: 'deny' };
      },
    });

    const result = await emitPermission(transport, {
      toolCallId: 't-ssh',
      kind: 'read',
      title: 'Read id_rsa',
      rawInput: { path: '~/.ssh/id_rsa' },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      kind: 'permission',
      toolName: 'read',
      input: { path: '~/.ssh/id_rsa' },
    });
    expect(result).toEqual({
      outcome: { outcome: 'selected', optionId: 'reject-once' },
    });
  });

  it('classifier throw → Ask path + unavailable hook', async () => {
    const transport = new FakeTransport();
    const classifierUnavailable = vi.fn();
    const seen: InteractionRequest[] = [];
    await bootCursorSession({
      transport,
      permissionMode: 'auto',
      classifyAutoPermission: async () => {
        throw new Error('classifier boom');
      },
      onAutoPermissionClassifierUnavailable: classifierUnavailable,
      interactionResolver: async (req) => {
        seen.push(req);
        return { kind: 'permission', behavior: 'deny' };
      },
    });

    await emitPermission(transport, {
      toolCallId: 't1',
      kind: 'read',
      title: 'Read',
      rawInput: { path: 'src/a.ts' },
    });
    expect(classifierUnavailable).toHaveBeenCalledWith({
      sessionId: 'biz-session-perm',
      agentKind: 'cursor',
      status: 500,
    });
    expect(seen).toHaveLength(1);
  });

  it('classifier missing → Ask path + unavailable hook', async () => {
    const transport = new FakeTransport();
    const classifierUnavailable = vi.fn();
    const seen: InteractionRequest[] = [];
    await bootCursorSession({
      transport,
      permissionMode: 'auto',
      // deliberately omit classifyAutoPermission
      onAutoPermissionClassifierUnavailable: classifierUnavailable,
      interactionResolver: async (req) => {
        seen.push(req);
        return { kind: 'permission', behavior: 'deny' };
      },
    });

    await emitPermission(transport, {
      toolCallId: 't1',
      kind: 'think',
      title: 'Think',
      rawInput: {},
    });
    expect(classifierUnavailable).toHaveBeenCalledWith({
      sessionId: 'biz-session-perm',
      agentKind: 'cursor',
      status: 500,
    });
    expect(seen).toHaveLength(1);
  });

  it('classifier timeout → Ask path + unavailable hook with 408', async () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();
    const classifierUnavailable = vi.fn();
    const seen: InteractionRequest[] = [];
    try {
      await bootCursorSession({
        transport,
        permissionMode: 'auto',
        classifyAutoPermission: () => new Promise(() => {}),
        onAutoPermissionClassifierUnavailable: classifierUnavailable,
        interactionResolver: async (req) => {
          seen.push(req);
          return { kind: 'permission', behavior: 'deny' };
        },
      });

      const pending = emitPermission(transport, {
        toolCallId: 't-timeout',
        kind: 'read',
        title: 'Read',
        rawInput: { path: 'src/a.ts' },
      });
      await vi.advanceTimersByTimeAsync(8_000);
      await pending;
      expect(classifierUnavailable).toHaveBeenCalledWith({
        sessionId: 'biz-session-perm',
        agentKind: 'cursor',
        status: 408,
      });
      expect(seen).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('CursorAgent MCP approval policy (shared host classifier)', () => {
  async function emitPermission(
    transport: FakeTransport,
    toolCall: Record<string, unknown>,
    id = 11,
  ): Promise<unknown> {
    transport.emitLine({
      jsonrpc: '2.0',
      id,
      method: Method.SessionRequestPermission,
      params: {
        sessionId: 'sess-perm',
        toolCall,
        options: OPTIONS,
      },
    });
    await vi.waitFor(() => expect(transport.findResponse(id)).toBeDefined());
    return transport.findResponse(id);
  }

  const prepareBrowserMcp: NonNullable<
    ConstructorParameters<typeof CursorAgent>[0]['prepareAcpMcpServers']
  > = async () => ({
    servers: [{ type: 'http', name: 'cindy_browser', url: 'http://127.0.0.1/mcp/cindy_browser' }],
  });

  it('auto-approves trusted MCP tools without opening the permission card', async () => {
    const transport = new FakeTransport();
    const seen: InteractionRequest[] = [];
    const policy = vi.fn(() => 'auto-approve' as const);
    await bootCursorSession({
      transport,
      permissionMode: 'ask',
      prepareAcpMcpServers: prepareBrowserMcp,
      getMcpToolApprovalPolicy: policy,
      interactionResolver: async (req) => {
        seen.push(req);
        return { kind: 'permission', behavior: 'deny' };
      },
    });

    const result = await emitPermission(transport, {
      toolCallId: 't-mcp',
      kind: 'other',
      title: 'mcp__cindy_browser__list_tools',
      rawInput: {},
    });
    expect(policy).toHaveBeenCalledWith({
      serverName: 'cindy_browser',
      toolName: 'list_tools',
      toolParams: {},
    });
    expect(seen).toHaveLength(0);
    expect(result).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    });
  });

  it('prompt-each-time forces a card even under Auto', async () => {
    const transport = new FakeTransport();
    const seen: InteractionRequest[] = [];
    await bootCursorSession({
      transport,
      permissionMode: 'auto',
      classifyAutoPermission: async () => 'allow',
      prepareAcpMcpServers: prepareBrowserMcp,
      getMcpToolApprovalPolicy: () => 'prompt-each-time',
      interactionResolver: async (req) => {
        seen.push(req);
        return { kind: 'permission', behavior: 'deny' };
      },
    });

    const result = await emitPermission(transport, {
      toolCallId: 't-mcp-risk',
      kind: 'other',
      title: 'mcp__cindy_browser__call_tool',
      rawInput: { name: 'navigate' },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.kind).toBe('permission');
    if (seen[0]?.kind === 'permission') {
      expect(seen[0].suggestions).toBeUndefined();
    }
    expect(result).toEqual({
      outcome: { outcome: 'selected', optionId: 'reject-once' },
    });
  });

  it('prompt-each-time forces a card even under Full access', async () => {
    const transport = new FakeTransport();
    const seen: InteractionRequest[] = [];
    await bootCursorSession({
      transport,
      permissionMode: 'bypassPermissions',
      prepareAcpMcpServers: prepareBrowserMcp,
      getMcpToolApprovalPolicy: () => 'prompt-each-time',
      interactionResolver: async (req) => {
        seen.push(req);
        return { kind: 'permission', behavior: 'deny' };
      },
    });

    const result = await emitPermission(transport, {
      toolCallId: 't-mcp-full',
      kind: 'other',
      title: 'mcp__cindy_browser__call_tool',
      rawInput: { name: 'contacts_delete' },
    });
    expect(seen).toHaveLength(1);
    expect(result).toEqual({
      outcome: { outcome: 'selected', optionId: 'reject-once' },
    });
  });

  it('generic MCP: tool title never auto-approves via rawInput impersonation', async () => {
    const transport = new FakeTransport();
    const seen: InteractionRequest[] = [];
    const policy = vi.fn(() => 'auto-approve' as const);
    await bootCursorSession({
      transport,
      permissionMode: 'bypassPermissions',
      prepareAcpMcpServers: prepareBrowserMcp,
      getMcpToolApprovalPolicy: policy,
      interactionResolver: async (req) => {
        seen.push(req);
        return { kind: 'permission', behavior: 'deny' };
      },
    });

    const result = await emitPermission(transport, {
      toolCallId: 't-spoof',
      kind: 'mcp',
      title: 'MCP: tool',
      rawInput: {
        name: 'contacts_delete',
        toolName: 'mcp__cindy_browser__list_tools',
      },
    });
    expect(policy).not.toHaveBeenCalled();
    expect(seen).toHaveLength(1);
    expect(result).toEqual({
      outcome: { outcome: 'selected', optionId: 'reject-once' },
    });
  });

  it('switching to Full cancels pending prompt-each-time instead of allowing', async () => {
    const transport = new FakeTransport();
    let resolveCard: ((d: InteractionDecision) => void) | null = null;
    const { handle } = await bootCursorSession({
      transport,
      permissionMode: 'ask',
      prepareAcpMcpServers: prepareBrowserMcp,
      getMcpToolApprovalPolicy: () => 'prompt-each-time',
      interactionResolver: async () =>
        await new Promise<InteractionDecision>((resolve) => {
          resolveCard = resolve;
        }),
    });

    const id = 8801;
    transport.emitLine({
      jsonrpc: '2.0',
      id,
      method: Method.SessionRequestPermission,
      params: {
        sessionId: 'sess-perm',
        toolCall: {
          toolCallId: 't-pending',
          kind: 'other',
          title: 'mcp__cindy_browser__call_tool',
          rawInput: {},
        },
        options: OPTIONS,
      },
    });
    await vi.waitFor(() => expect(resolveCard).not.toBeNull());
    await handle.setPermissionMode!('bypassPermissions');
    await vi.waitFor(() => expect(transport.findResponse(id)).toBeDefined());
    expect(transport.findResponse(id)).toEqual({
      outcome: { outcome: 'cancelled' },
    });
    // Avoid hanging the unresolved InteractionDecision promise.
    resolveCard?.({ kind: 'permission', behavior: 'deny' });
    await handle.close();
  });
});

describe('AcpClient answers request_permission with selected optionId', () => {
  it('writes jsonrpc selected/allow-once (not bare allow_always outcome)', async () => {
    const transport = new FakeTransport();
    const client = new AcpClient({
      createTransport: () => transport,
      logger: createConsoleLogger('acp-perm'),
    });
    client.setRequestHandler('session/request_permission', async () =>
      toRequestPermissionResult({ kind: 'permission', behavior: 'allow' }, OPTIONS),
    );
    client.start();
    transport.emitLine({
      jsonrpc: '2.0',
      id: 7,
      method: 'session/request_permission',
      params: {
        sessionId: 's',
        toolCall: { toolCallId: 't', kind: 'execute', title: 'x' },
        options: OPTIONS,
      },
    });
    await vi.waitFor(() => expect(transport.lines.length).toBe(1));
    expect(JSON.parse(transport.lines[0] ?? '')).toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: { outcome: { outcome: 'selected', optionId: 'allow-once' } },
    });
  });
});
