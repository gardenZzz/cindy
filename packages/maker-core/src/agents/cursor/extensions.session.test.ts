/**
 * CursorAgent planMode + extension RPC wiring (FakeTransport).
 */

import { describe, expect, it } from 'vitest';

import { CursorAgent } from './index.js';
import { createConsoleLogger } from '../../interfaces/logger.js';
import type { AuthAdapter } from '../../interfaces/auth-adapter.js';
import type { AgentEvent, InteractionRequest } from '../../types/events.js';
import type { CloseHandler, LineHandler, StderrHandler, Transport } from '../acp/transport.js';
import { CursorMethod, JSONRPC_VERSION, Method } from '../acp/protocol.js';
import { CURSOR_TODOS_TOOL_USE_ID } from './extensions.js';

class FakeTransport implements Transport {
  readonly written: unknown[] = [];
  private readonly lineHandlers = new Set<LineHandler>();
  private readonly closeHandlers = new Set<CloseHandler>();
  private closed = false;
  pid = 5150;

  async writeLine(line: string): Promise<void> {
    this.written.push(JSON.parse(line));
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
    return this.closed ? null : this.pid;
  }
  async close(reason = 'fake close'): Promise<void> {
    if (this.closed) return;
    this.closed = true;
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
  findAllRequests(method: string): Array<{ id: number | string; params?: unknown }> {
    const out: Array<{ id: number | string; params?: unknown }> = [];
    for (const msg of this.written) {
      if (
        isRecord(msg) &&
        msg.method === method &&
        (typeof msg.id === 'number' || typeof msg.id === 'string')
      ) {
        out.push({ id: msg.id as number | string, params: msg.params });
      }
    }
    return out;
  }
  findResponse(id: number | string): unknown {
    for (const msg of this.written) {
      if (isRecord(msg) && msg.id === id && 'result' in msg) return msg.result;
    }
    return undefined;
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

async function boot(transport: FakeTransport, startOpts: Record<string, unknown> = {}) {
  const agent = new CursorAgent({
    auth: authStub(),
    runtimeConfig: {},
    binaryPath: '/dev/null/cursor-agent',
    logger: createConsoleLogger('cursor-ext-session'),
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
          result: {
            sessionId: 'sess-ext',
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
      queueMicrotask(() =>
        transport.emit({ jsonrpc: JSONRPC_VERSION, id: msg.id, result: {} }),
      );
    }
  };

  const handle = await agent.startSession({
    workingDir: '/tmp',
    model: 'default',
    vendorOptions: { createAcpTransport: () => transport },
    ...startOpts,
  });
  return { agent, handle };
}

describe('CursorAgent planMode + extensions (FakeTransport)', () => {
  it('setPlanMode(true) sends session/set_mode(plan); ask mode never sent', async () => {
    const transport = new FakeTransport();
    const { handle } = await boot(transport);
    await handle.setPlanMode?.(true);
    const modes = transport.findAllRequests(Method.SessionSetMode);
    expect(modes.some((m) => isRecord(m.params) && m.params.modeId === 'plan')).toBe(true);
    expect(modes.every((m) => isRecord(m.params) && m.params.modeId !== 'ask')).toBe(true);
    expect(handle.getPlanMode?.()).toBe(true);
    await handle.close();
  });

  it('startSession(planMode) arms ACP plan mode', async () => {
    const transport = new FakeTransport();
    const { handle } = await boot(transport, { planMode: true });
    const modes = transport.findAllRequests(Method.SessionSetMode);
    expect(modes[0]?.params).toMatchObject({ modeId: 'plan' });
    await handle.close();
  });

  it('create_plan approve → plan_review allow + session/set_mode(agent)', async () => {
    const transport = new FakeTransport();
    const { handle } = await boot(transport, { planMode: true });
    const seen: InteractionRequest[] = [];
    handle.setInteractionResolver(async (req) => {
      seen.push(req);
      if (req.kind === 'plan_review') {
        return { kind: 'plan_review', behavior: 'allow' };
      }
      return { kind: 'permission', behavior: 'deny' };
    });

    const events: AgentEvent[] = [];
    const consume = (async () => {
      for await (const ev of handle.events()) events.push(ev);
    })();

    transport.emit({
      jsonrpc: JSONRPC_VERSION,
      id: 9001,
      method: CursorMethod.CreatePlan,
      params: {
        toolCallId: 'call_plan',
        plan: '1. do X\n2. do Y',
        todos: [],
      },
    });

    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !transport.findResponse(9001)) {
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(seen[0]).toMatchObject({ kind: 'plan_review', plan: '1. do X\n2. do Y' });
    expect(transport.findResponse(9001)).toEqual({ outcome: { outcome: 'accepted' } });
    expect(
      transport.findAllRequests(Method.SessionSetMode).some(
        (m) => isRecord(m.params) && m.params.modeId === 'agent',
      ),
    ).toBe(true);

    await handle.close();
    await consume;
  });

  it('create_plan reject returns rejected outcome and stays without agent switch', async () => {
    const transport = new FakeTransport();
    const { handle } = await boot(transport);
    handle.setInteractionResolver(async (req) => {
      if (req.kind === 'plan_review') {
        return { kind: 'plan_review', behavior: 'deny', reason: 'revise steps' };
      }
      return { kind: 'permission', behavior: 'deny' };
    });
    const consume = (async () => {
      for await (const _ev of handle.events()) {
        /* drain */
      }
    })();

    transport.emit({
      jsonrpc: JSONRPC_VERSION,
      id: 9002,
      method: CursorMethod.CreatePlan,
      params: { toolCallId: 'p', plan: 'bad plan', todos: [] },
    });

    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !transport.findResponse(9002)) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(transport.findResponse(9002)).toEqual({
      outcome: { outcome: 'rejected', reason: 'revise steps' },
    });
    await handle.close();
    await consume;
  });

  it('ask_question routes to ask_user_question and returns answered', async () => {
    const transport = new FakeTransport();
    const { handle } = await boot(transport);
    handle.setInteractionResolver(async (req) => {
      if (req.kind === 'ask_user_question') {
        return { kind: 'ask_user_question', answers: { 'Pick one?': 'Yes' } };
      }
      return { kind: 'permission', behavior: 'deny' };
    });
    const consume = (async () => {
      for await (const _ev of handle.events()) {
        /* drain */
      }
    })();

    transport.emit({
      jsonrpc: JSONRPC_VERSION,
      id: 9003,
      method: CursorMethod.AskQuestion,
      params: {
        toolCallId: 'aq',
        questions: [
          {
            id: 'q1',
            prompt: 'Pick one?',
            options: [
              { id: 'yes', label: 'Yes' },
              { id: 'no', label: 'No' },
            ],
          },
        ],
      },
    });

    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !transport.findResponse(9003)) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(transport.findResponse(9003)).toEqual({
      outcome: {
        outcome: 'answered',
        answers: [{ questionId: 'q1', selectedOptionIds: ['yes'] }],
      },
    });
    await handle.close();
    await consume;
  });

  it('update_todos emits update_plan tool_use and accepts', async () => {
    const transport = new FakeTransport();
    const { handle } = await boot(transport);
    const events: AgentEvent[] = [];
    const consume = (async () => {
      for await (const ev of handle.events()) events.push(ev);
    })();

    transport.emit({
      jsonrpc: JSONRPC_VERSION,
      id: 9004,
      method: CursorMethod.UpdateTodos,
      params: {
        toolCallId: 'todo1',
        merge: false,
        todos: [
          { id: '1', content: 'Setup', status: 'completed' },
          { id: '2', content: 'Auth', status: 'in_progress' },
        ],
      },
    });

    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !transport.findResponse(9004)) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(transport.findResponse(9004)).toMatchObject({
      outcome: { outcome: 'accepted' },
    });

    const tool = events.find((e) => e.type === 'tool_use');
    expect(tool).toMatchObject({
      type: 'tool_use',
      data: {
        toolUseId: CURSOR_TODOS_TOOL_USE_ID,
        toolName: 'update_plan',
      },
    });

    await handle.close();
    await consume;
  });

  it('send with armed planMode emits plan_mode_changed(false)', async () => {
    const transport = new FakeTransport();
    const { handle } = await boot(transport);
    await handle.setPlanMode?.(true);
    expect(handle.getPlanMode?.()).toBe(true);

    const events: AgentEvent[] = [];
    const consume = (async () => {
      for await (const ev of handle.events()) events.push(ev);
    })();

    const sendPromise = handle.send({ type: 'user', content: 'please plan this' });
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !transport.findRequest(Method.SessionPrompt)) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const prompt = transport.findRequest(Method.SessionPrompt);
    expect(prompt).toBeTruthy();
    transport.emit({
      jsonrpc: JSONRPC_VERSION,
      id: prompt!.id,
      result: { stopReason: 'end_turn' },
    });
    await sendPromise;

    const waitEv = Date.now() + 500;
    while (
      Date.now() < waitEv &&
      !events.some((e) => e.type === 'plan_mode_changed')
    ) {
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(
      events.some(
        (e) => e.type === 'plan_mode_changed' && (e.data as { enabled?: boolean }).enabled === false,
      ),
    ).toBe(true);
    expect(handle.getPlanMode?.()).toBe(false);

    await handle.close();
    await consume;
  });
});
