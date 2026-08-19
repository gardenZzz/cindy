import { describe, expect, it, vi } from 'vitest';

import { createAsyncQueue } from '../../shared/async-queue.js';
import { UsageTracker } from '../../shared/usage-tracker.js';
import {
  newRuntimeState,
  translateSdkMessage,
  type TurnState,
} from '../translator.js';
import type { AgentEvent } from '../../../types/events.js';

// uiEmittedText 记账: includePartialMessages 写死为 true, text_delta 与完整
// assistant text block 都会 push。记账必须按 parent 去重,否则 emitted 是真实
// 正文的两倍, result.result 前缀比对永远 mismatch,末尾截断兜底(tail 分支)
// 从未生效。完整消息一律不累加也不行:只发 assistant、不发 delta 时 emitted
// 恒为 0,收尾会把整段正文当缺失尾巴再推一遍(用户可见重复)。

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

function createCtx() {
  return {
    rt: newRuntimeState(),
    turn: createTurnState(),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    getModel: () => 'claude-fable-5',
    getEffort: () => 'high' as const,
    getPermissionMode: () => 'auto' as const,
    onSessionId: vi.fn(),
    getSdkSessionId: () => undefined,
    getLogTitle: () => undefined,
    tracker: new UsageTracker(),
    getModelContextWindow: () => 1_000_000,
  };
}

async function drain(queue: ReturnType<typeof createAsyncQueue<AgentEvent>>): Promise<AgentEvent[]> {
  queue.end();
  const events: AgentEvent[] = [];
  for await (const event of queue) events.push(event);
  return events;
}

function textEvents(events: AgentEvent[]): Array<{ text?: string; isFinal?: boolean }> {
  return events
    .filter((event) => event.type === 'text')
    .map((event) => event.data as { text?: string; isFinal?: boolean });
}

function pushTextDelta(
  queue: ReturnType<typeof createAsyncQueue<AgentEvent>>,
  ctx: ReturnType<typeof createCtx>,
  text: string,
  parentToolUseId: string | null = null,
): void {
  translateSdkMessage(
    {
      type: 'stream_event',
      parent_tool_use_id: parentToolUseId,
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
    },
    queue,
    ctx,
  );
}

function pushAssistantText(
  queue: ReturnType<typeof createAsyncQueue<AgentEvent>>,
  ctx: ReturnType<typeof createCtx>,
  text: string,
  parentToolUseId: string | null = null,
): void {
  translateSdkMessage(
    {
      type: 'assistant',
      parent_tool_use_id: parentToolUseId,
      message: { content: [{ type: 'text', text }] },
    },
    queue,
    ctx,
  );
}

function pushResult(
  queue: ReturnType<typeof createAsyncQueue<AgentEvent>>,
  ctx: ReturnType<typeof createCtx>,
  result: string,
): void {
  translateSdkMessage(
    {
      type: 'result',
      stop_reason: 'end_turn',
      result,
      total_cost_usd: 0.1,
      usage: { input_tokens: 1000, output_tokens: 2 },
    },
    queue,
    ctx,
  );
}

describe('Claude Code translator uiEmittedText accounting and truncation fallback', () => {
  it('full: empty emitted repairs the whole result.result', async () => {
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx();

    pushResult(queue, ctx, '整段回复');

    const events = await drain(queue);
    expect(textEvents(events)).toEqual([{ text: '整段回复', isFinal: false }]);
  });

  it('tail: result.result longer than emitted only appends the missing suffix', async () => {
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx();

    pushTextDelta(queue, ctx, '旁白。');
    expect(ctx.turn.uiEmittedText).toBe('旁白。');
    pushResult(queue, ctx, '旁白。被截断的尾巴');

    const events = await drain(queue);
    expect(textEvents(events)).toEqual([
      { text: '旁白。', isFinal: false },
      { text: '被截断的尾巴', isFinal: false },
    ]);
  });

  it('complete: matching result.result does not append a fallback tail', async () => {
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx();

    pushTextDelta(queue, ctx, '完整答复。');
    pushAssistantText(queue, ctx, '完整答复。');
    expect(ctx.turn.uiEmittedText).toBe('完整答复。');
    pushResult(queue, ctx, '完整答复。');

    const events = await drain(queue);
    expect(textEvents(events)).toEqual([
      { text: '完整答复。', isFinal: false },
      { text: '完整答复。', isFinal: true },
    ]);
  });

  it('mismatch: result.result that does not start with emitted is left unrepaired', async () => {
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx();

    pushAssistantText(queue, ctx, '已推正文。');
    expect(ctx.turn.uiEmittedText).toBe('已推正文。');
    pushResult(queue, ctx, '对不上的 result');

    const events = await drain(queue);
    expect(textEvents(events)).toEqual([{ text: '已推正文。', isFinal: true }]);
  });

  it('does not duplicate a complete-only assistant message at result time', async () => {
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx();

    pushAssistantText(queue, ctx, '只走完整消息。');
    expect(ctx.turn.uiEmittedText).toBe('只走完整消息。');
    pushResult(queue, ctx, '只走完整消息。');

    const events = await drain(queue);
    expect(textEvents(events)).toEqual([{ text: '只走完整消息。', isFinal: true }]);
  });

  it('counts delta plus complete block once, not twice', async () => {
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx();
    const visible = 'Hello world';

    pushTextDelta(queue, ctx, 'Hello ');
    pushTextDelta(queue, ctx, 'world');
    pushAssistantText(queue, ctx, visible);

    await drain(queue);
    expect(ctx.turn.uiEmittedText).toBe(visible);
    expect(ctx.turn.uiEmittedText.length).toBe(visible.length);
  });

  it('does not let a subagent stream flag skip main-agent complete text', async () => {
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx();

    pushTextDelta(queue, ctx, '子代理。', 'toolu-child');
    pushAssistantText(queue, ctx, '主流。');

    await drain(queue);
    expect(ctx.turn.uiEmittedText).toBe('子代理。主流。');
    expect(ctx.rt.streamStopTokenByKey.get('toolu-child:0')).toEqual({
      pending: '',
      emitted: true,
    });
  });

  it('does not let a main stream flag skip subagent complete text', async () => {
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx();

    pushTextDelta(queue, ctx, '主流。');
    pushAssistantText(queue, ctx, '子代理。', 'toolu-child');

    await drain(queue);
    expect(ctx.turn.uiEmittedText).toBe('主流。子代理。');
    expect(ctx.rt.streamStopTokenByKey.get('__main__:0')).toEqual({
      pending: '',
      emitted: true,
    });
  });
});
