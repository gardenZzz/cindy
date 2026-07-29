/**
 * Cursor permission-mode + ACP outcome policy unit tests.
 */

import { describe, expect, it, vi } from 'vitest';

import { createConsoleLogger } from '../../interfaces/logger.js';
import type { AuthAdapter } from '../../interfaces/auth-adapter.js';
import { CursorAgent } from './index.js';
import type { Transport, LineHandler, CloseHandler } from '../acp/transport.js';
import { AcpClient } from '../acp/client.js';
import {
  autoClassifierAllowsKind,
  sessionAllowKeyFromToolCall,
  toInteractionRequest,
  toRequestPermissionResult,
} from '../acp/permissions.js';
import type { PermissionOption } from '../acp/protocol.js';

const OPTIONS: PermissionOption[] = [
  { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
  { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
];

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
  private lineHandler: LineHandler | null = null;
  private closeHandler: CloseHandler | null = null;

  async writeLine(line: string): Promise<void> {
    this.lines.push(line);
  }
  onLine(handler: LineHandler): () => void {
    this.lineHandler = handler;
    return () => {
      if (this.lineHandler === handler) this.lineHandler = null;
    };
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
}

describe('CursorAgent capabilities — permission modes', () => {
  it('declares ask / auto / bypassPermissions and mid-session switch', () => {
    const agent = new CursorAgent({
      auth: createAuthStub(),
      runtimeConfig: {},
      binaryPath: '/tmp/fake-cursor-agent',
      logger: createConsoleLogger('cursor-perm-test'),
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

  it('Auto classifier distinguishes safe vs risky kinds', () => {
    expect(autoClassifierAllowsKind('read')).toBe(true);
    expect(autoClassifierAllowsKind('execute')).toBe(false);
  });

  it('InteractionRequest carries sessionAllowKey for Cindy-layer memory', () => {
    const toolCall = {
      toolCallId: 't1',
      kind: 'execute' as const,
      title: '`rm -rf /`',
      rawInput: { command: 'rm -rf /' },
    };
    expect(sessionAllowKeyFromToolCall(toolCall)).toBe('execute:rm');
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
        { destination: 'session', sessionAllowKey: 'execute:rm' },
      ]);
    }
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
