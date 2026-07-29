/**
 * CursorAgent lifecycle unit tests with FakeTransport (no real cursor-agent).
 * Covers: session/load resume + history suppress, invalid-resume CAS,
 * abort → immediate idle, tool-idle timeout → session/cancel.
 */

import { describe, expect, it, vi } from 'vitest';

import { CursorAgent } from './index.js';
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

  findNotifications(method: string): unknown[] {
    return this.written.filter(
      (msg) => isRecord(msg) && msg.method === method && !('id' in msg),
    );
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

async function drainUntil(
  events: AsyncIterable<AgentEvent>,
  pred: (ev: AgentEvent) => boolean,
  timeoutMs = 2000,
): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  const iter = events[Symbol.asyncIterator]();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const next = await Promise.race([
      iter.next(),
      new Promise<{ done: true; value: undefined }>((resolve) =>
        setTimeout(() => resolve({ done: true, value: undefined }), remaining),
      ),
    ]);
    if (next.done) break;
    if (next.value) {
      out.push(next.value);
      if (pred(next.value)) break;
    }
  }
  return out;
}

async function bootWithTransport(
  transport: FakeTransport,
  startOpts: Record<string, unknown> = {},
): Promise<{ agent: CursorAgent; handle: Awaited<ReturnType<CursorAgent['startSession']>> }> {
  const agent = new CursorAgent({
    auth: authStub(),
    runtimeConfig: {},
    binaryPath: '/dev/null/cursor-agent',
    logger: createConsoleLogger('cursor-lifecycle-unit'),
  });

  // Respond to initialize + session create/load as requests arrive.
  const autoReply = transport.onLine(() => {
    /* armed by client.start */
  });
  autoReply();

  // Patch writeLine to auto-respond to initialize / session/* synchronously after push.
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
    if (msg.method === Method.SessionLoad) {
      const params = msg.params as { sessionId?: string };
      const sid = params?.sessionId ?? '';
      queueMicrotask(() => {
        // History replay BEFORE result — must be suppressed by CursorAgent.
        transport.emit({
          jsonrpc: JSONRPC_VERSION,
          method: Method.SessionUpdate,
          params: {
            sessionId: sid,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'REPLAYED_HISTORY' },
            },
          },
        });
        if (sid === 'dead-session') {
          transport.emit({
            jsonrpc: JSONRPC_VERSION,
            id: msg.id,
            error: {
              code: -32602,
              message: 'Invalid params',
              data: { message: `Session "${sid}" not found` },
            },
          });
          return;
        }
        transport.emit({
          jsonrpc: JSONRPC_VERSION,
          id: msg.id,
          result: { models: MODELS },
        });
      });
      return;
    }
    if (msg.method === Method.SessionSetConfigOption) {
      queueMicrotask(() =>
        transport.emit({
          jsonrpc: JSONRPC_VERSION,
          id: msg.id,
          result: { configOptions: [] },
        }),
      );
      return;
    }
    if (msg.method === Method.SessionSetMode) {
      queueMicrotask(() =>
        transport.emit({
          jsonrpc: JSONRPC_VERSION,
          id: msg.id,
          result: {},
        }),
      );
      return;
    }
    if (msg.method === Method.SessionPrompt) {
      // Hang by default — tests complete/cancel explicitly.
      return;
    }
  };

  const handlePromise = agent.startSession({
    sessionId: 'biz-1',
    model: 'auto',
    workingDir: '/tmp',
    vendorOptions: { createAcpTransport: () => transport },
    ...startOpts,
  });

  const handle = await handlePromise;
  return { agent, handle };
}

describe('CursorAgent lifecycle (FakeTransport)', () => {
  it('resume via session/load skips upstream history replay', async () => {
    const transport = new FakeTransport();
    const { handle } = await bootWithTransport(transport, {
      resumeSessionId: 'resume-me-please',
    });

    const load = transport.findRequest(Method.SessionLoad);
    expect(load).toBeTruthy();
    expect((load!.params as { sessionId: string }).sessionId).toBe('resume-me-please');
    expect(handle.id).toBe('resume-me-please');

    // Collect any events emitted during load — must NOT contain REPLAYED_HISTORY text.
    const early: AgentEvent[] = [];
    const consume = (async () => {
      for await (const ev of handle.events()) {
        early.push(ev);
        if (early.length > 20) break;
      }
    })();

    // Give microtasks a tick, then close.
    await new Promise((r) => setTimeout(r, 30));
    await handle.close();
    await consume;

    const textBlobs = early
      .filter((e) => e.type === 'text')
      .map((e) => String((e.data as { text?: string }).text ?? ''));
    expect(textBlobs.join('')).not.toContain('REPLAYED_HISTORY');
  });

  it('invalid resume clears via CAS and creates a fresh session with readable hint', async () => {
    const transport = new FakeTransport();
    const cas = vi.fn(async () => true);
    const { handle } = await bootWithTransport(transport, {
      resumeSessionId: 'dead-session',
      onInvalidResumeSession: cas,
    });

    expect(cas).toHaveBeenCalledWith('dead-session');
    expect(handle.id).toBe('fresh-session-id');
    expect(transport.findRequest(Method.SessionNew)).toBeTruthy();

    const events: AgentEvent[] = [];
    const consume = (async () => {
      for await (const ev of handle.events()) {
        events.push(ev);
        if (ev.type === 'session_id') break;
      }
    })();
    await Promise.race([consume, new Promise((r) => setTimeout(r, 500))]);
    await handle.close();

    const hint = events.find((e) => e.type === 'error');
    expect(hint).toBeTruthy();
    expect(String((hint!.data as { message?: string }).message)).toContain('无法恢复');
    expect((hint!.data as { isTerminal?: boolean }).isTerminal).toBe(false);
  });

  it('abort sends session/cancel and immediately returns UI to idle', async () => {
    const transport = new FakeTransport();
    const { handle } = await bootWithTransport(transport);

    const events: AgentEvent[] = [];
    const consume = (async () => {
      for await (const ev of handle.events()) {
        events.push(ev);
      }
    })();

    const sendPromise = handle.send({ type: 'user', content: 'hello' });
    // Wait until SessionPrompt is written.
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline && !transport.findRequest(Method.SessionPrompt)) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(transport.findRequest(Method.SessionPrompt)).toBeTruthy();

    await handle.abort();

    // Immediate idle — before prompt RPC returns.
    const idle = await drainUntil(
      (async function* () {
        for (const ev of events) yield ev;
        for await (const ev of handle.events()) yield ev;
      })(),
      (ev) => ev.type === 'status' && (ev.data as { isRunning?: boolean }).isRunning === false,
      500,
    ).catch(() => events);

    const sawCancelledStatus = events.some(
      (e) =>
        e.type === 'status' &&
        (e.data as { isRunning?: boolean; text?: string }).isRunning === false,
    );
    expect(sawCancelledStatus).toBe(true);
    expect(transport.findNotifications(Method.SessionCancel).length).toBeGreaterThan(0);

    // Complete the hanging prompt so send() can finish.
    const prompt = transport.findRequest(Method.SessionPrompt)!;
    transport.emit({
      jsonrpc: JSONRPC_VERSION,
      id: prompt.id,
      result: { stopReason: 'cancelled' },
    });
    await sendPromise;
    await handle.close();
    await consume;
    void idle;
  });

  it('tool-call idle watchdog cancels with readable timeout message', async () => {
    vi.stubEnv('CINDY_CURSOR_TOOL_IDLE_MS', '50');
    const transport = new FakeTransport();
    const { handle } = await bootWithTransport(transport);

    const events: AgentEvent[] = [];
    const consume = (async () => {
      for await (const ev of handle.events()) {
        events.push(ev);
      }
    })();

    const sendPromise = handle.send({ type: 'user', content: 'use a tool' });
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline && !transport.findRequest(Method.SessionPrompt)) {
      await new Promise((r) => setTimeout(r, 10));
    }

    transport.emit({
      jsonrpc: JSONRPC_VERSION,
      method: Method.SessionUpdate,
      params: {
        sessionId: handle.id,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'hanging-tool',
          title: 'Shell',
          kind: 'execute',
          status: 'in_progress',
        },
      },
    });

    // Wait for watchdog.
    const timeoutDeadline = Date.now() + 2000;
    while (Date.now() < timeoutDeadline) {
      if (
        events.some(
          (e) =>
            e.type === 'error' &&
            String((e.data as { reason?: string }).reason) === 'tool_call_idle_timeout',
        )
      ) {
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }

    const errEv = events.find(
      (e) =>
        e.type === 'error' &&
        (e.data as { reason?: string }).reason === 'tool_call_idle_timeout',
    );
    expect(errEv).toBeTruthy();
    expect(String((errEv!.data as { message?: string }).message)).toContain('无活动');
    expect(transport.findNotifications(Method.SessionCancel).length).toBeGreaterThan(0);

    const prompt = transport.findRequest(Method.SessionPrompt)!;
    transport.emit({
      jsonrpc: JSONRPC_VERSION,
      id: prompt.id,
      result: { stopReason: 'cancelled' },
    });
    await sendPromise;
    await handle.close();
    await consume;
    vi.unstubAllEnvs();
  });

  it('startSession throws AgentNotAuthenticatedError when auth is missing', async () => {
    const { AgentNotAuthenticatedError } = await import('../base-agent.js');
    const agent = new CursorAgent({
      auth: {
        getState: async () => ({ authenticated: false, errorReason: 'no_credentials' }),
        triggerLogin: async () => ({ authenticated: false }),
        logout: async () => undefined,
        getAuthEnv: async () => ({}),
      },
      runtimeConfig: {},
      binaryPath: '/dev/null/cursor-agent',
      logger: createConsoleLogger(),
    });
    await expect(
      agent.startSession({
        workingDir: '/tmp',
        vendorOptions: {
          createAcpTransport: () => {
            throw new Error('should not spawn when unauthenticated');
          },
        },
      }),
    ).rejects.toBeInstanceOf(AgentNotAuthenticatedError);
  });
});
