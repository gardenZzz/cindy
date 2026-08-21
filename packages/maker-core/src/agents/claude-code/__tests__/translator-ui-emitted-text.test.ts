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

  // 同一条 assistant 携带多个 text block 时,「已流式」必须在遍历 content 之前一次
  // 算完。逐块重算的话,第一个 block 的清理循环会删光该 parent 的 key,第二个 block
  // 看到空表就误判成"没流过"、把第二段再累加一遍 —— emitted 变长,本该命中的 tail
  // 分支退化成 mismatch,兜底又一次静默失效。
  it('counts every text block once when one assistant message carries several', async () => {
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx();

    pushTextDelta(queue, ctx, '第一段。');
    pushTextDelta(queue, ctx, '第二段。');
    translateSdkMessage(
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: '第一段。' },
            { type: 'text', text: '第二段。' },
          ],
        },
      },
      queue,
      ctx,
    );
    expect(ctx.turn.uiEmittedText).toBe('第一段。第二段。');

    // 判别性收口: result 比 emitted 多一段尾巴,记账正确时 tail 分支补出「被截断的尾巴。」;
    // 若第二段被重复累加,前缀比对会 mismatch,这里就一条都补不出来。
    pushResult(queue, ctx, '第一段。第二段。被截断的尾巴。');

    const events = await drain(queue);
    expect(textEvents(events).at(-1)).toEqual({ text: '被截断的尾巴。', isFinal: false });
  });
});
