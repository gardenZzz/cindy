import { describe, expect, it, vi } from 'vitest';

import { createAsyncQueue } from '../../shared/async-queue.js';
import { UsageTracker } from '../../shared/usage-tracker.js';
import {
  newRuntimeState,
  translateSdkMessage,
  type TurnState,
} from '../translator.js';
import type { AgentEvent } from '../../../types/events.js';

// 异常日志的归因字段: 会话配置的模型 id 只是用户视角的身份,网关可能把它分流到别的
// 实际模型。只记配置 id 会把 A 模型的故障算到 B 头上(排查 silent-stop 时就发生过:
// 按告警字段统计得到「glm-5.2 有 3 次」,核对 transcript 才发现是 gemini 产生的)。
// 三条 WARN 都同时记配置 id 与上游自报的 wire model;wire model 缺失时不打占位值。

const CONFIGURED_MODEL = 'gemini-3.7-flash-high';
const WIRE_MODEL = 'gemini-3.7-flash-exp-a';

function createTurnState(): TurnState {
  return {
    text: '',
    toolUses: 0,
    apiCalls: 0,
    sawCompactBoundary: false,
    hasEmittedText: false,
    uiEmittedText: '',
    uiEmittedTextLenAtLastToolUse: 0,
    pendingApiError: null,
    interruptRequested: false,
    generation: 0,
    interruptGeneration: 0,
    lastAssistantMsgHadSubstance: true,
  };
}

function createCtx(tracker: UsageTracker) {
  return {
    rt: newRuntimeState(),
    turn: createTurnState(),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    getModel: () => CONFIGURED_MODEL,
    getEffort: () => 'high' as const,
    getPermissionMode: () => 'auto' as const,
    onSessionId: vi.fn(),
    getSdkSessionId: () => undefined,
    getLogTitle: () => undefined,
    tracker,
    getModelContextWindow: () => 1_000_000,
  };
}

async function drain(queue: ReturnType<typeof createAsyncQueue<AgentEvent>>): Promise<AgentEvent[]> {
  queue.end();
  const events: AgentEvent[] = [];
  for await (const event of queue) events.push(event);
  return events;
}

/** 取指定 WARN 的 payload。 */
function warnPayload(
  ctx: ReturnType<typeof createCtx>,
  fragment: string,
): Record<string, unknown> | undefined {
  const call = ctx.log.warn.mock.calls.find(
    ([message]) => typeof message === 'string' && message.includes(fragment),
  );
  return call?.[1] as Record<string, unknown> | undefined;
}

function pushApiCall(
  queue: ReturnType<typeof createAsyncQueue<AgentEvent>>,
  ctx: ReturnType<typeof createCtx>,
): void {
  translateSdkMessage(
    {
      type: 'stream_event',
      event: { type: 'message_start', message: { model: CONFIGURED_MODEL, usage: { input_tokens: 1000 } } },
    },
    queue,
    ctx,
  );
}

/** 主流 assistant 消息,自报 wire model。 */
function pushAssistant(
  queue: ReturnType<typeof createAsyncQueue<AgentEvent>>,
  ctx: ReturnType<typeof createCtx>,
  content: unknown[],
  model: string | null = WIRE_MODEL,
  parentToolUseId?: string,
): void {
  translateSdkMessage(
    {
      type: 'assistant',
      ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}),
      message: { ...(model ? { model } : {}), content },
    },
    queue,
    ctx,
  );
}

/** silent-stop 形态: 干过活(tool_use)、其后无正文、末条消息零内容。 */
function pushSilentStopTurn(
  queue: ReturnType<typeof createAsyncQueue<AgentEvent>>,
  ctx: ReturnType<typeof createCtx>,
  model: string | null = WIRE_MODEL,
): void {
  pushApiCall(queue, ctx);
  pushAssistant(queue, ctx, [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: {} }], model);
  pushAssistant(queue, ctx, [{ type: 'thinking', thinking: '', signature: 'sig' }], model);
  translateSdkMessage(
    {
      type: 'result',
      stop_reason: 'end_turn',
      total_cost_usd: 0.1,
      usage: { input_tokens: 1000, output_tokens: 2 },
    },
    queue,
    ctx,
  );
}

describe('Claude Code translator wire-model attribution in WARN logs', () => {
  it('records both the configured id and the differing wire model on silent stop', async () => {
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(new UsageTracker());

    pushSilentStopTurn(queue, ctx);
    await drain(queue);

    const payload = warnPayload(ctx, 'silent stop');
    expect(payload?.model).toBe(CONFIGURED_MODEL);
    expect(payload?.wireModel).toBe(WIRE_MODEL);
  });

  it('records the wire model on an empty-response turn', async () => {
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(new UsageTracker());

    pushApiCall(queue, ctx);
    pushAssistant(queue, ctx, []);
    translateSdkMessage(
      {
        type: 'result',
        stop_reason: 'end_turn',
        total_cost_usd: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
      queue,
      ctx,
    );
    await drain(queue);

    const payload = warnPayload(ctx, 'empty response');
    expect(payload?.model).toBe(CONFIGURED_MODEL);
    expect(payload?.wireModel).toBe(WIRE_MODEL);
  });

  it('records the wire model on an errored turn', async () => {
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(new UsageTracker());

    pushApiCall(queue, ctx);
    pushAssistant(queue, ctx, [{ type: 'text', text: '开工。' }]);
    translateSdkMessage(
      {
        type: 'result',
        is_error: true,
        stop_reason: 'error_during_execution',
        total_cost_usd: 0.1,
        usage: { input_tokens: 1000, output_tokens: 2 },
      },
      queue,
      ctx,
    );
    await drain(queue);

    const payload = warnPayload(ctx, 'turn ended with error');
    expect(payload?.model).toBe(CONFIGURED_MODEL);
    expect(payload?.wireModel).toBe(WIRE_MODEL);
  });

  it('omits the field entirely when the gateway reports no wire model', async () => {
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(new UsageTracker());

    pushSilentStopTurn(queue, ctx, null);
    await drain(queue);

    const payload = warnPayload(ctx, 'silent stop');
    expect(payload?.model).toBe(CONFIGURED_MODEL);
    // 缺省时不留 'unknown' 之类的占位噪音,键本身不出现。
    expect(payload && 'wireModel' in payload).toBe(false);
  });

  it('does not leak the previous turn wire model into the next turn', async () => {
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(new UsageTracker());

    // 第一轮上游自报 wire model,第二轮不报 —— 跨 turn 复用会再造一次错误归因。
    pushSilentStopTurn(queue, ctx, WIRE_MODEL);
    expect(ctx.turn.lastAssistantWireModel).toBeUndefined();
    pushSilentStopTurn(queue, ctx, null);
    await drain(queue);

    const payloads = ctx.log.warn.mock.calls
      .filter(([message]) => typeof message === 'string' && message.includes('silent stop'))
      .map(([, payload]) => payload as Record<string, unknown>);
    expect(payloads).toHaveLength(2);
    expect(payloads[0]?.wireModel).toBe(WIRE_MODEL);
    expect(payloads[1] && 'wireModel' in payloads[1]).toBe(false);
  });

  it('does not take the wire model from a subagent message', async () => {
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(new UsageTracker());

    pushApiCall(queue, ctx);
    pushAssistant(queue, ctx, [{ type: 'tool_use', id: 'tool-1', name: 'Task', input: {} }], WIRE_MODEL);
    // 子代理跑在自己的模型上,不该顶替主流的归因依据。这里让它只发 tool_use 不发正文,
    // 否则子代理正文会累加进主 turn 的 uiEmittedText,silent stop 根本不触发。
    pushAssistant(
      queue,
      ctx,
      [{ type: 'tool_use', id: 'tool-child', name: 'Read', input: {} }],
      'claude-haiku-4-5',
      'tool-1',
    );
    pushAssistant(queue, ctx, [{ type: 'thinking', thinking: '', signature: 'sig' }], WIRE_MODEL);
    translateSdkMessage(
      {
        type: 'result',
        stop_reason: 'end_turn',
        total_cost_usd: 0.1,
        usage: { input_tokens: 1000, output_tokens: 2 },
      },
      queue,
      ctx,
    );
    await drain(queue);

    const payload = warnPayload(ctx, 'silent stop');
    expect(payload?.wireModel).toBe(WIRE_MODEL);
  });
});
