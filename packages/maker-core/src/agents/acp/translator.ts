/**
 * ACP session/update → Cindy AgentEvent translator (标准面, 无 vendor 特性)。
 *
 * 覆盖: 纯文本流式 + tool_call/tool_call_update + status / done / error + usage 两通道预接。
 */

import type { AgentEvent, UsageSnapshot } from '../../types/events.js';
import type { Logger } from '../../interfaces/logger.js';
import { UsageTracker } from '../shared/usage-tracker.js';
import {
  toolInputFromAcpToolCall,
  toolNameFromAcpToolCall,
} from './permissions.js';
import type {
  PromptResponse,
  PromptUsage,
  SessionUpdate,
  SessionUpdateNotification,
  ToolCallUpdate,
  UsageUpdate,
} from './protocol.js';

export interface AcpToolMeta {
  toolName: string;
  input: Record<string, unknown>;
  title?: string;
  kind?: string;
}

export interface AcpTranslateRuntime {
  /** 本 turn 已累积的 agent 文本 (用于 turn end 的 isFinal 全文)。 */
  textBuf: string;
  /** 当前 turn 是否已向 UI 推过 running status。 */
  statusRunningEmitted: boolean;
  /** 已 emit tool_use 的 toolCallId。 */
  emittedToolUse: Set<string>;
  /** toolCallId → 最近一次已知元数据 (update 补丁合并用)。 */
  toolMeta: Map<string, AcpToolMeta>;
}

export function newAcpRuntime(): AcpTranslateRuntime {
  return {
    textBuf: '',
    statusRunningEmitted: false,
    emittedToolUse: new Set(),
    toolMeta: new Map(),
  };
}

export function resetAcpTurn(rt: AcpTranslateRuntime): void {
  rt.textBuf = '';
  rt.statusRunningEmitted = false;
  rt.emittedToolUse.clear();
  rt.toolMeta.clear();
}

export interface AcpTranslateContext {
  rt: AcpTranslateRuntime;
  usage: UsageTracker;
  log: Logger;
  /** AgentEvent.source — Cursor 子类传 'cursor'; 通用层默认 'cursor'。 */
  source?: 'cursor';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * status 事件的文案字段名是 `status` —— 全链路消费方(renderer handleStatusUpdate、
 * agent-island、完成通知的 `status === 'Done'` 判定)都读这个 key。曾误写成 `text`,
 * 结果 Cursor 会话的 agentStatus.status 恒为 undefined(状态栏本地化崩、完成通知不发)。
 */
function pushStatus(
  events: AgentEvent[],
  ctx: AcpTranslateContext,
  opts: { isRunning: boolean; status: string },
): void {
  const snap: UsageSnapshot = ctx.usage.snapshot();
  events.push({
    type: 'status',
    data: {
      isRunning: opts.isRunning,
      status: opts.status,
      ...snap,
    },
    source: ctx.source ?? 'cursor',
  });
}

/**
 * 翻译一条 session/update notification → 0+ AgentEvent。
 * 未知 sessionUpdate 返回空数组 (不抛)。
 */
export function translateSessionUpdate(
  params: unknown,
  ctx: AcpTranslateContext,
): AgentEvent[] {
  if (!isRecord(params)) {
    ctx.log.debug('session/update: non-object params');
    return [];
  }
  const notification = params as Partial<SessionUpdateNotification>;
  const update = notification.update;
  if (!isRecord(update) || typeof update.sessionUpdate !== 'string') {
    ctx.log.debug('session/update: missing update.sessionUpdate');
    return [];
  }

  const kind = update.sessionUpdate;
  if (kind === 'agent_message_chunk') {
    return translateAgentMessageChunk(update as SessionUpdate, ctx);
  }
  if (kind === 'usage_update') {
    return translateUsageUpdate(update as unknown as UsageUpdate, ctx);
  }
  if (kind === 'tool_call' || kind === 'tool_call_update') {
    return translateToolCallUpdate(update as unknown as ToolCallUpdate, ctx);
  }

  ctx.log.debug('session/update: ignored', { sessionUpdate: kind });
  return [];
}

function translateAgentMessageChunk(
  update: SessionUpdate,
  ctx: AcpTranslateContext,
): AgentEvent[] {
  if (!isRecord(update)) return [];
  const content = update.content;
  if (!isRecord(content) || content.type !== 'text' || typeof content.text !== 'string') {
    ctx.log.debug('agent_message_chunk: non-text content ignored', {
      type: isRecord(content) ? content.type : typeof content,
    });
    return [];
  }
  const delta = content.text;
  if (delta.length === 0) return [];

  const events: AgentEvent[] = [];
  if (!ctx.rt.statusRunningEmitted) {
    ctx.rt.statusRunningEmitted = true;
    pushStatus(events, ctx, { isRunning: true, status: 'Generating...' });
  }
  ctx.rt.textBuf += delta;
  events.push({
    type: 'text',
    data: { text: delta, isFinal: false },
    source: ctx.source ?? 'cursor',
  });
  return events;
}

function mergeToolMeta(
  rt: AcpTranslateRuntime,
  update: ToolCallUpdate,
): AcpToolMeta {
  const prev = rt.toolMeta.get(update.toolCallId);
  const asToolCall: Partial<ToolCallUpdate> = {
    toolCallId: update.toolCallId,
    title: typeof update.title === 'string' ? update.title : prev?.title,
    kind: (typeof update.kind === 'string' ? update.kind : prev?.kind) as ToolCallUpdate['kind'],
    rawInput:
      update.rawInput !== undefined
        ? update.rawInput
        : prev?.input && Object.keys(prev.input).length > 0
          ? prev.input
          : undefined,
    content: update.content ?? undefined,
  };

  const meta: AcpToolMeta = {
    toolName: toolNameFromAcpToolCall(asToolCall),
    input: toolInputFromAcpToolCall(asToolCall),
    title: typeof asToolCall.title === 'string' ? asToolCall.title : prev?.title,
    kind: typeof asToolCall.kind === 'string' ? asToolCall.kind : prev?.kind,
  };
  rt.toolMeta.set(update.toolCallId, meta);
  return meta;
}

function formatToolOutput(update: ToolCallUpdate): string {
  if (update.rawOutput !== undefined && update.rawOutput !== null) {
    if (typeof update.rawOutput === 'string') return update.rawOutput;
    try {
      return JSON.stringify(update.rawOutput, null, 2);
    } catch {
      return String(update.rawOutput);
    }
  }
  if (Array.isArray(update.content)) {
    const parts: string[] = [];
    for (const item of update.content) {
      if (!isRecord(item)) continue;
      if (item.type === 'content' && isRecord(item.content) && item.content.type === 'text') {
        if (typeof item.content.text === 'string') parts.push(item.content.text);
      } else if (item.type === 'text' && typeof item.text === 'string') {
        parts.push(item.text);
      } else if (item.type === 'diff' && typeof item.path === 'string') {
        parts.push(`diff ${item.path}`);
      }
    }
    if (parts.length > 0) return parts.join('\n');
  }
  return '';
}

/**
 * tool_call / tool_call_update → tool_use (+ tool_result_full + tool_result on terminal)。
 * 与 codex translator 同形: started/首见出 tool_use, completed/failed 出结果对。
 */
function translateToolCallUpdate(
  update: ToolCallUpdate,
  ctx: AcpTranslateContext,
): AgentEvent[] {
  if (typeof update.toolCallId !== 'string' || !update.toolCallId) {
    ctx.log.debug('tool_call: missing toolCallId');
    return [];
  }

  const events: AgentEvent[] = [];
  if (!ctx.rt.statusRunningEmitted) {
    ctx.rt.statusRunningEmitted = true;
    pushStatus(events, ctx, { isRunning: true, status: 'Running...' });
  }

  const meta = mergeToolMeta(ctx.rt, update);
  const status = typeof update.status === 'string' ? update.status : undefined;
  const terminal = status === 'completed' || status === 'failed';

  if (!ctx.rt.emittedToolUse.has(update.toolCallId)) {
    ctx.rt.emittedToolUse.add(update.toolCallId);
    events.push({
      type: 'tool_use',
      data: {
        toolUseId: update.toolCallId,
        toolName: meta.toolName,
        input: meta.input,
      },
      source: ctx.source ?? 'cursor',
    });
  } else if (
    update.rawInput !== undefined ||
    typeof update.title === 'string' ||
    typeof update.kind === 'string'
  ) {
    // 输入/标题补丁: 再推一条 tool_use 覆盖展示 (与 codex updated 兜底同思路 — UI 按 id upsert)。
    // 仅在非终态时补；终态走 result。
    if (!terminal) {
      events.push({
        type: 'tool_use',
        data: {
          toolUseId: update.toolCallId,
          toolName: meta.toolName,
          input: meta.input,
        },
        source: ctx.source ?? 'cursor',
      });
    }
  }

  if (!terminal) return events;

  ctx.rt.emittedToolUse.delete(update.toolCallId);
  const isError = status === 'failed';
  const fullText = formatToolOutput(update);
  events.push({
    type: 'tool_result_full',
    data: {
      toolUseId: update.toolCallId,
      fullText,
      isError,
    },
    source: ctx.source ?? 'cursor',
  });
  events.push({
    type: 'tool_result',
    data: {
      summary: status === 'failed' ? 'Failed' : 'Done',
      toolUseIds: [update.toolCallId],
    },
    source: ctx.source ?? 'cursor',
  });
  return events;
}

/**
 * usage_update 通道预接。
 * 有 used/size 才写入 tracker; 缺字段 / 非法 → 保持「无数据」(tracker 仍为 0)。
 * 不做本地估算。
 */
function translateUsageUpdate(update: UsageUpdate, ctx: AcpTranslateContext): AgentEvent[] {
  const used = typeof update.used === 'number' && Number.isFinite(update.used) ? update.used : null;
  const size = typeof update.size === 'number' && Number.isFinite(update.size) ? update.size : null;
  if (used === null || size === null) {
    ctx.log.debug('usage_update: missing used/size — treating as no data');
    return [];
  }
  if (size > 0) ctx.usage.setContextWindow(size);
  if (used > 0) {
    ctx.usage.setContextTokensAfterCompact(used);
  }
  const events: AgentEvent[] = [];
  pushStatus(events, ctx, {
    isRunning: true,
    status: ctx.rt.statusRunningEmitted ? 'Generating...' : 'Running...',
  });
  return events;
}

/**
 * 把 PromptResponse.usage 写入 tracker。usage 缺省 / null / 全空 → 不 ingest (保持无数据)。
 * 返回是否实际写入了有效 usage。
 */
export function ingestPromptUsage(
  usage: PromptUsage | null | undefined,
  tracker: UsageTracker,
): boolean {
  if (!usage || typeof usage !== 'object') return false;
  const input = typeof usage.inputTokens === 'number' ? usage.inputTokens : 0;
  const output = typeof usage.outputTokens === 'number' ? usage.outputTokens : 0;
  const cacheRead = typeof usage.cachedReadTokens === 'number' ? usage.cachedReadTokens : 0;
  const cacheCreate = typeof usage.cachedWriteTokens === 'number' ? usage.cachedWriteTokens : 0;
  const total = typeof usage.totalTokens === 'number' ? usage.totalTokens : 0;
  if (input <= 0 && output <= 0 && cacheRead <= 0 && cacheCreate <= 0 && total <= 0) {
    return false;
  }
  tracker.ingestApiCallUsage({
    inputTokens: input > 0 ? input : Math.max(0, total - output),
    outputTokens: output,
    cacheReadTokens: cacheRead > 0 ? cacheRead : undefined,
    cacheCreateTokens: cacheCreate > 0 ? cacheCreate : undefined,
  });
  return true;
}

/**
 * session/prompt 返回后收尾: 可选 final text + done + status idle。
 * usage 有数据才 endTurn 锁定; 否则 endTurn() 空调 (清 turn 累加, 快照仍为「无数据」0)。
 */
export function finishPromptTurn(
  response: PromptResponse,
  ctx: AcpTranslateContext,
): AgentEvent[] {
  const events: AgentEvent[] = [];
  const hadUsage = ingestPromptUsage(response.usage, ctx.usage);

  if (ctx.rt.textBuf.length > 0) {
    events.push({
      type: 'text',
      data: { text: ctx.rt.textBuf, isFinal: true },
      source: ctx.source ?? 'cursor',
    });
  }

  const snap = hadUsage
    ? ctx.usage.endTurn({
        inputTokens: ctx.usage.getTurnUsage().input,
        outputTokens: ctx.usage.getTurnUsage().output,
        cacheReadTokens: ctx.usage.getTurnUsage().cacheRead,
        cacheCreateTokens: ctx.usage.getTurnUsage().cacheCreate,
      })
    : ctx.usage.endTurn();

  events.push({
    type: 'done',
    data: {
      stopReason: response.stopReason,
      reason: response.stopReason,
    },
    source: ctx.source ?? 'cursor',
  });
  events.push({
    type: 'status',
    data: {
      isRunning: false,
      status: response.stopReason === 'cancelled' ? 'Cancelled' : 'Done',
      ...snap,
    },
    source: ctx.source ?? 'cursor',
  });

  resetAcpTurn(ctx.rt);
  return events;
}

/** transport / RPC 失败 → 终止型 error + status idle。 */
export function translateAcpError(
  err: Error,
  ctx: AcpTranslateContext,
  opts?: { isTerminal?: boolean; reason?: string },
): AgentEvent[] {
  const isTerminal = opts?.isTerminal !== false;
  const events: AgentEvent[] = [
    {
      type: 'error',
      data: {
        message: err.message,
        isTerminal,
        ...(opts?.reason ? { reason: opts.reason } : {}),
      },
      source: ctx.source ?? 'cursor',
    },
  ];
  if (isTerminal) {
    events.push({
      type: 'status',
      data: {
        isRunning: false,
        status: 'Error',
        ...ctx.usage.snapshot(),
      },
      source: ctx.source ?? 'cursor',
    });
    resetAcpTurn(ctx.rt);
  }
  return events;
}
