/**
 * Session 层：abort / watchdog 后 reservation 归还 + 旧轮晚到响应不得污染新轮。
 * lifecycle.test.ts 只打 Cursor handle，锁不住 Session.sendReservation 契约。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CursorAgent } from './index.js';
import { Session } from '../../session.js';
import { createConsoleLogger } from '../../interfaces/logger.js';
import type { AuthAdapter } from '../../interfaces/auth-adapter.js';
import type { AgentEvent } from '../../types/events.js';
import type { CloseHandler, LineHandler, StderrHandler, Transport } from '../acp/transport.js';
import { JSONRPC_VERSION, Method } from '../acp/protocol.js';

class FakeTransport implements Transport {
  readonly written: unknown[] = [];
  private readonly lineHandlers = new Set<LineHandler>();
  private readonly stderrHandlers = new Set<StderrHandler>();
  private readonly closeHandlers = new Set<CloseHandler>();
  private closed = false;
  pid = 4242;

  async writeLine(line: string): Promise<void> {
    this.written.push(JSON.parse(line));
  }

  onLine(handler: LineHandler): () => void {
    this.lineHandlers.add(handler);
    return () => this.lineHandlers.delete(handler);
  }

  onStderr(handler: StderrHandler): () => void {
    this.stderrHandlers.add(handler);
    return () => this.stderrHandlers.delete(handler);
  }

  onClose(handler: CloseHandler): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  getPid(): number | null {
    return this.closed ? null : this.pid;
  }

  async close(reason = 'fake close'): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.pid = 0;
    for (const h of this.closeHandlers) h({ reason });
  }

  emit(value: unknown): void {
    const line = typeof value === 'string' ? value : JSON.stringify(value);
    for (const h of this.lineHandlers) h(line);
  }

  findRequest(method: string): { id: number | string; params?: unknown } | undefined {
    for (const msg of this.written) {
      if (
        isRecord(msg) &&
        msg.method === method &&
        (typeof msg.id === 'number' || typeof msg.id === 'string')
      ) {
        return { id: msg.id as number | string, params: msg.params };
      }
    }
    return undefined;
  }

  findAllRequests(method: string): Array<{ id: number | string }> {
    const out: Array<{ id: number | string }> = [];
    for (const msg of this.written) {
      if (
        isRecord(msg) &&
        msg.method === method &&
        (typeof msg.id === 'number' || typeof msg.id === 'string')
      ) {
        out.push({ id: msg.id as number | string });
      }
    }
    return out;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function authStub(): AuthAdapter {
  return {
    getState: async () => ({ authenticated: true }),
    triggerLogin: async () => ({ authenticated: true }),
    logout: async () => undefined,
    getAuthEnv: async () => ({}),
  };
}

const MODELS = {
  currentModelId: 'default',
  availableModels: [{ modelId: 'default', name: 'Auto' }],
};

async function waitForPrompt(
  transport: FakeTransport,
  minCount = 1,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (transport.findAllRequests(Method.SessionPrompt).length >= minCount) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`SessionPrompt not written (want >= ${minCount})`);
}

function emitToolCall(transport: FakeTransport, sessionId: string, toolCallId: string): void {
  transport.emit({
    jsonrpc: JSONRPC_VERSION,
    method: Method.SessionUpdate,
    params: {
      sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId,
        title: 'Shell',
        kind: 'execute',
        status: 'in_progress',
      },
    },
  });
}

function completePrompt(
  transport: FakeTransport,
  promptId: number | string,
  stopReason: string = 'cancelled',
): void {
  transport.emit({
    jsonrpc: JSONRPC_VERSION,
    id: promptId,
    result: { stopReason },
  });
}

async function bootSession(
  transport: FakeTransport,
): Promise<{ session: Session; handle: Awaited<ReturnType<CursorAgent['startSession']>> }> {
  const agent = new CursorAgent({
    auth: authStub(),
    runtimeConfig: { userDataPath: '/tmp/cindy-cursor-session-reservation-test' },
    binaryPath: '/dev/null/cursor-agent',
    logger: createConsoleLogger('cursor-session-reservation'),
  });

  const origWrite = transport.writeLine.bind(transport);
  transport.writeLine = async (line: string) => {
    await origWrite(line);
    const msg = JSON.parse(line) as Record<string, unknown>;
    if (typeof msg.id !== 'number' && typeof msg.id !== 'string') return;
    if (msg.method === Method.Initialize) {
      queueMicrotask(() =>
        transport.emit({
          jsonrpc: JSONRPC_VERSION,
          id: msg.id,
          result: {
            protocolVersion: 1,
            agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
            authMethods: [],
          },
        }),
      );
      return;
    }
    if (msg.method === Method.SessionNew) {
      queueMicrotask(() =>
        transport.emit({
          jsonrpc: JSONRPC_VERSION,
          id: msg.id,
          result: { sessionId: 'fresh-session-id', models: MODELS },
        }),
      );
      return;
    }
    if (msg.method === Method.SessionSetConfigOption || msg.method === Method.SessionSetMode) {
      queueMicrotask(() =>
        transport.emit({
          jsonrpc: JSONRPC_VERSION,
          id: msg.id,
          result: msg.method === Method.SessionSetConfigOption ? { configOptions: [] } : {},
        }),
      );
      return;
    }
    if (msg.method === Method.SessionPrompt) {
      // Hang — tests complete prompts explicitly.
      return;
    }
  };

  const handle = await agent.startSession({
    sessionId: 'biz-reservation',
    model: 'auto',
    workingDir: '/tmp',
    vendorOptions: { createAcpTransport: () => transport },
  });

  const session = new Session({
    id: 'biz-reservation',
    agentKind: 'cursor',
    workDir: '/tmp',
    handle,
    capabilities: agent.capabilities,
    logger: createConsoleLogger('cursor-session-reservation-s'),
  });

  // Drain events so Session.releaseSendReservationIfObserved 能跑。
  session.onEvent(() => undefined);

  return { session, handle };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Cursor × Session reservation + turn generation', () => {
  it('abort releases Session busy so B can run; late A cannot clear B watchdog or accept C', async () => {
    vi.stubEnv('CINDY_CURSOR_TOOL_IDLE_MS', '30000');
    const transport = new FakeTransport();
    const { session, handle } = await bootSession(transport);

    const events: AgentEvent[] = [];
    session.onEvent((ev) => events.push(ev));

    const acceptedA = await session.send('turn-A');
    expect(acceptedA).toEqual({ accepted: true });
    await waitForPrompt(transport, 1);
    expect(session.isTurnRunning()).toBe(true);

    await session.abort();
    expect(session.isTurnRunning()).toBe(false);

    const acceptedB = await session.send('turn-B');
    expect(acceptedB).toEqual({ accepted: true });
    await waitForPrompt(transport, 2);
    expect(session.isTurnRunning()).toBe(true);

    emitToolCall(transport, handle.id, 'b-tool');
    await new Promise((r) => setTimeout(r, 20));

    const prompts = transport.findAllRequests(Method.SessionPrompt);
    expect(prompts.length).toBe(2);
    const doneBeforeLateA = events.filter((e) => e.type === 'done').length;
    const idleBeforeLateA = events.filter(
      (e) => e.type === 'status' && (e.data as { isRunning?: boolean }).isRunning === false,
    ).length;

    // A 晚到：若无 generation 守卫会清 B 的 toolIdle、发错误 done/status、finally 把 B 标 idle。
    completePrompt(transport, prompts[0]!.id, 'cancelled');
    await new Promise((r) => setTimeout(r, 30));

    expect(session.isTurnRunning()).toBe(true);
    expect(events.filter((e) => e.type === 'done').length).toBe(doneBeforeLateA);
    expect(
      events.filter(
        (e) => e.type === 'status' && (e.data as { isRunning?: boolean }).isRunning === false,
      ).length,
    ).toBe(idleBeforeLateA);
    await expect(session.send('turn-C')).rejects.toMatchObject({ code: 'SESSION_RUNNING' });

    // B 仍 busy：完成 B 后应能再发。
    completePrompt(transport, prompts[1]!.id, 'end_turn');
    await vi.waitFor(() => expect(session.isTurnRunning()).toBe(false));
    await expect(session.send('turn-after-B')).resolves.toEqual({ accepted: true });

    await session.close();
  });

  it('watchdog timeout releases Session busy; late A response does not finalize B', async () => {
    vi.stubEnv('CINDY_CURSOR_TOOL_IDLE_MS', '40');
    const transport = new FakeTransport();
    const { session, handle } = await bootSession(transport);

    const events: AgentEvent[] = [];
    session.onEvent((ev) => events.push(ev));

    await session.send('turn-A');
    await waitForPrompt(transport, 1);
    emitToolCall(transport, handle.id, 'hanging-a');

    await vi.waitFor(
      () => {
        expect(
          events.some(
            (e) =>
              e.type === 'error' &&
              (e.data as { reason?: string }).reason === 'tool_call_idle_timeout',
          ),
        ).toBe(true);
      },
      { timeout: 2000 },
    );
    expect(session.isTurnRunning()).toBe(false);

    await session.send('turn-B');
    await waitForPrompt(transport, 2);
    expect(session.isTurnRunning()).toBe(true);

    const prompts = transport.findAllRequests(Method.SessionPrompt);
    completePrompt(transport, prompts[0]!.id, 'cancelled');
    await new Promise((r) => setTimeout(r, 30));

    expect(session.isTurnRunning()).toBe(true);
    await expect(session.send('turn-C')).rejects.toMatchObject({ code: 'SESSION_RUNNING' });

    // A 晚到后不应再推一对 cancelled done（B 仍 running）；B 自己收尾才 idle。
    const doneAfterA = events.filter((e) => e.type === 'done').length;
    completePrompt(transport, prompts[1]!.id, 'end_turn');
    await vi.waitFor(() => expect(session.isTurnRunning()).toBe(false));
    expect(events.filter((e) => e.type === 'done').length).toBeGreaterThanOrEqual(doneAfterA);

    await session.close();
  });
});
