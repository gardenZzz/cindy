/**
 * Cursor available_commands_update → listAgentSkills 会话隔离单测。
 */

import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createConsoleLogger } from '../../interfaces/logger.js';
import type { AuthAdapter } from '../../interfaces/auth-adapter.js';
import { CursorAgent } from './index.js';
import type { Transport, LineHandler, CloseHandler, StderrHandler } from '../acp/transport.js';
import { JSONRPC_VERSION, Method } from '../acp/protocol.js';

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
}

describe('CursorAgent available_commands_update → listAgentSkills', () => {
  it('stores session-scoped commands and clears them on close', async () => {
    const transport = new FakeTransport();
    const userDataPath = mkdtempSync(join(tmpdir(), 'cindy-cursor-cmds-'));
    const agent = new CursorAgent({
      auth: createAuthStub(),
      runtimeConfig: { userDataPath },
      binaryPath: '/tmp/fake-cursor-agent',
      logger: createConsoleLogger('cursor-cmds-test'),
      networkConfigReader: () => undefined,
    });

    const origWrite = transport.writeLine.bind(transport);
    transport.writeLine = async (line: string) => {
      await origWrite(line);
      const msg = JSON.parse(line) as Record<string, unknown>;
      if (typeof msg.id !== 'number' && typeof msg.id !== 'string') return;
      if (msg.method === Method.Initialize) {
        queueMicrotask(() =>
          transport.emitLine({
            jsonrpc: JSONRPC_VERSION,
            id: msg.id,
            result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] },
          }),
        );
        return;
      }
      if (msg.method === Method.SessionNew) {
        queueMicrotask(() =>
          transport.emitLine({
            jsonrpc: JSONRPC_VERSION,
            id: msg.id,
            result: {
              sessionId: 'acp-sess',
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
      await expect(agent.listAgentSkills({})).resolves.toEqual({ skills: [] });
      await expect(agent.listAgentSkills({ sessionId: 'biz-1' })).resolves.toEqual({ skills: [] });

      const handle = await agent.startSession({
        workingDir: '/tmp',
        model: 'default',
        sessionId: 'biz-1',
        vendorOptions: { createAcpTransport: () => transport },
      });
      await handle.bootstrapReady;

      transport.emitLine({
        jsonrpc: '2.0',
        method: Method.SessionUpdate,
        params: {
          sessionId: 'acp-sess',
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: [
              { name: 'web', description: 'Search', input: { hint: 'query' } },
              { name: 'test' },
            ],
          },
        },
      });

      await vi.waitFor(async () => {
        const listed = await agent.listAgentSkills({ sessionId: 'biz-1' });
        expect(listed.skills.map((s) => s.name)).toEqual(['web', 'test']);
      });
      // 其它会话 / 无 sessionId 不串清单
      await expect(agent.listAgentSkills({ sessionId: 'biz-other' })).resolves.toEqual({ skills: [] });
      await expect(agent.listAgentSkills({})).resolves.toEqual({ skills: [] });

      await handle.close();
      await expect(agent.listAgentSkills({ sessionId: 'biz-1' })).resolves.toEqual({ skills: [] });
    } finally {
      await agent.dispose().catch(() => undefined);
      rmSync(userDataPath, { recursive: true, force: true });
    }
  });
});
