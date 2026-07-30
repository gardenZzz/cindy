import { describe, expect, it, vi } from 'vitest';

import { UsageTracker } from '../shared/usage-tracker.js';
import type { Logger } from '../../interfaces/logger.js';
import {
  finishPromptTurn,
  ingestPromptUsage,
  newAcpRuntime,
  translateAcpError,
  translateSessionUpdate,
  type AcpTranslateContext,
} from './translator.js';

const logger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: () => logger,
};

function makeCtx(): AcpTranslateContext {
  return {
    rt: newAcpRuntime(),
    usage: new UsageTracker(),
    log: logger,
    source: 'cursor',
  };
}

describe('translateSessionUpdate — agent_message_chunk text path', () => {
  it('streams text deltas and emits running status once', () => {
    const ctx = makeCtx();
    const first = translateSessionUpdate(
      {
        sessionId: 's1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Hello' },
        },
      },
      ctx,
    );
    expect(first.map((e) => e.type)).toEqual(['status', 'text']);
    expect(first[0]?.data).toMatchObject({ isRunning: true, status: 'Generating...' });
    expect(first[1]?.data).toEqual({ text: 'Hello', isFinal: false });

    const second = translateSessionUpdate(
      {
        sessionId: 's1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'msg_1',
          content: { type: 'text', text: ' world' },
        },
      },
      ctx,
    );
    expect(second).toHaveLength(1);
    expect(second[0]?.data).toEqual({ text: ' world', isFinal: false });
    expect(ctx.rt.textBuf).toBe('Hello world');
  });

  it('ignores non-text content and unknown sessionUpdate kinds', () => {
    const ctx = makeCtx();
    expect(
      translateSessionUpdate(
        {
          sessionId: 's1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'image', data: 'abc', mimeType: 'image/png' },
          },
        },
        ctx,
      ),
    ).toEqual([]);
    expect(
      translateSessionUpdate(
        {
          sessionId: 's1',
          update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
        },
        ctx,
      ),
    ).toEqual([]);
  });

  it('translates tool_call + tool_call_update into tool_use / tool_result pair', () => {
    const ctx = makeCtx();
    const started = translateSessionUpdate(
      {
        sessionId: 's1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 't1',
          title: '`uname -s`',
          kind: 'execute',
          status: 'pending',
          rawInput: { command: 'uname -s' },
        },
      },
      ctx,
    );
    expect(started.map((e) => e.type)).toEqual(['status', 'tool_use']);
    expect(started[1]?.data).toEqual({
      toolUseId: 't1',
      toolName: 'exec',
      input: { command: 'uname -s' },
    });

    const completed = translateSessionUpdate(
      {
        sessionId: 's1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 't1',
          status: 'completed',
          rawOutput: { output: 'Darwin\n' },
        },
      },
      ctx,
    );
    expect(completed.map((e) => e.type)).toEqual(['tool_result_full', 'tool_result']);
    expect(completed[0]?.data).toMatchObject({
      toolUseId: 't1',
      isError: false,
    });
    expect(String((completed[0]?.data as { fullText?: string }).fullText)).toContain('Darwin');
    expect(completed[1]?.data).toEqual({ summary: 'Done', toolUseIds: ['t1'] });
  });

  it('emits failed tool_result when status=failed', () => {
    const ctx = makeCtx();
    translateSessionUpdate(
      {
        sessionId: 's1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 't-fail',
          kind: 'edit',
          title: 'Edit File',
          status: 'pending',
        },
      },
      ctx,
    );
    const failed = translateSessionUpdate(
      {
        sessionId: 's1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 't-fail',
          status: 'failed',
        },
      },
      ctx,
    );
    expect(failed.map((e) => e.type)).toEqual(['tool_result_full', 'tool_result']);
    expect(failed[0]?.data).toMatchObject({ toolUseId: 't-fail', isError: true });
    expect(failed[1]?.data).toEqual({ summary: 'Failed', toolUseIds: ['t-fail'] });
  });
});

describe('usage channels — PromptResponse.usage + usage_update', () => {
  it('keeps snapshot as no-data (zeros) when usage is absent', () => {
    const ctx = makeCtx();
    expect(ingestPromptUsage(undefined, ctx.usage)).toBe(false);
    expect(ingestPromptUsage(null, ctx.usage)).toBe(false);
    expect(ingestPromptUsage({}, ctx.usage)).toBe(false);
    expect(ctx.usage.snapshot()).toEqual({
      tokenUsage: 0,
      contextTokens: 0,
      contextWindow: 0,
      costUsd: 0,
    });

    const events = finishPromptTurn({ stopReason: 'end_turn' }, ctx);
    expect(events.map((e) => e.type)).toEqual(['done', 'status']);
    expect(events[1]?.data).toMatchObject({
      isRunning: false,
      tokenUsage: 0,
      contextTokens: 0,
      contextWindow: 0,
      costUsd: 0,
    });
  });

  it('ingests PromptResponse.usage when present', () => {
    const ctx = makeCtx();
    ctx.rt.textBuf = 'done text';
    const events = finishPromptTurn(
      {
        stopReason: 'end_turn',
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          cachedReadTokens: 10,
          totalTokens: 130,
        },
      },
      ctx,
    );
    expect(events[0]?.type).toBe('text');
    expect(events[0]?.data).toEqual({ text: 'done text', isFinal: true });
    expect(events.map((e) => e.type)).toEqual(['text', 'done', 'status']);
    // endTurn resets currentTurn; contextTokens retains lastApi
    expect(events[2]?.data).toMatchObject({
      isRunning: false,
      tokenUsage: 120,
      contextTokens: 110,
    });
  });

  it('pre-wires usage_update into context ring without inventing turn tokens', () => {
    const ctx = makeCtx();
    const events = translateSessionUpdate(
      {
        sessionId: 's1',
        update: {
          sessionUpdate: 'usage_update',
          used: 53000,
          size: 200000,
          cost: { amount: 0.045, currency: 'USD' },
        },
      },
      ctx,
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('status');
    expect(events[0]?.data).toMatchObject({
      contextTokens: 53000,
      contextWindow: 200000,
      // cost 不在 mid-stream 估算进 tracker; tokenUsage 仍为 0 (无 PromptResponse.usage)
      tokenUsage: 0,
      costUsd: 0,
    });
  });

  it('treats malformed usage_update as no data', () => {
    const ctx = makeCtx();
    expect(
      translateSessionUpdate(
        {
          sessionId: 's1',
          update: { sessionUpdate: 'usage_update', used: 'nope', size: 1 },
        },
        ctx,
      ),
    ).toEqual([]);
    expect(ctx.usage.snapshot().contextTokens).toBe(0);
  });
});

describe('finishPromptTurn + translateAcpError', () => {
  it('emits cancelled status text on cancelled stopReason', () => {
    const ctx = makeCtx();
    const events = finishPromptTurn({ stopReason: 'cancelled' }, ctx);
    expect(events[1]?.data).toMatchObject({ isRunning: false, status: 'Cancelled' });
  });

  it('emits terminal error + idle status', () => {
    const ctx = makeCtx();
    const events = translateAcpError(new Error('boom'), ctx);
    expect(events.map((e) => e.type)).toEqual(['error', 'status']);
    expect(events[0]?.data).toMatchObject({ message: 'boom', isTerminal: true });
    expect(events[1]?.data).toMatchObject({ isRunning: false, status: 'Error' });
  });
});
