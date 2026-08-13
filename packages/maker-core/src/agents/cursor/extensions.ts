/**
 * Cursor ACP vendor 扩展方法 ↔ Cindy InteractionRequest / AgentEvent。
 *
 *  - cursor/ask_question     → ask_user_question
 *  - cursor/create_plan      → plan_review
 *  - cursor/update_todos     → tool_use(update_plan)（复用 messageRender todo 卡）
 *  - cursor/task             → tool_use(Task) + agent_task_update（共享任务卡）
 *  - cursor/generate_image   → image(kind=generation)（host 入 cindy-media）
 *
 * 协议形状以官方 docs + cursor-agent / 第三方 ACP 客户端对照为准；不进 agents/acp 标准面。
 */

import { isAbsolute, relative, resolve } from 'node:path';

import type { SubagentObservation } from '@cindy/maker-shared/subagent-observation';

import type {
  AgentEvent,
  AgentTaskStatus,
  AgentTaskUpdateEventData,
  AskUserQuestionItem,
  ImageEventData,
  InteractionDecision,
} from '../../types/events.js';

export type CursorTodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

export interface CursorTodoItem {
  id: string;
  content: string;
  status: CursorTodoStatus;
}

export interface CursorAskQuestionOption {
  id: string;
  label: string;
}

export interface CursorAskQuestionItem {
  id: string;
  prompt: string;
  options: CursorAskQuestionOption[];
  allowMultiple?: boolean;
}

export interface CursorAskQuestionParams {
  toolCallId: string;
  title?: string;
  questions: CursorAskQuestionItem[];
}

/** Cursor ask_question 单题回答：选项 id + 可选自由文本（proto: freeformText）。 */
export interface CursorAskQuestionAnswer {
  questionId: string;
  selectedOptionIds: string[];
  /** 不在 option 集合里的自由输入；有则必传，空则省略。 */
  freeformText?: string;
}

export type CursorAskQuestionResponse = {
  outcome:
    | {
        outcome: 'answered';
        answers: CursorAskQuestionAnswer[];
      }
    | { outcome: 'skipped'; reason?: string }
    | { outcome: 'cancelled' };
};

export interface CursorCreatePlanParams {
  toolCallId: string;
  name?: string;
  overview?: string;
  plan: string;
  todos: CursorTodoItem[];
  isProject?: boolean;
  phases?: Array<{ name: string; todos: CursorTodoItem[] }>;
}

export type CursorCreatePlanResponse = {
  outcome:
    | { outcome: 'accepted'; planUri?: string }
    | { outcome: 'rejected'; reason?: string }
    | { outcome: 'cancelled' };
};

export interface CursorUpdateTodosParams {
  toolCallId: string;
  todos: CursorTodoItem[];
  merge: boolean;
}

export type CursorUpdateTodosResponse = {
  outcome:
    | { outcome: 'accepted'; todos: CursorTodoItem[] }
    | { outcome: 'rejected'; reason?: string }
    | { outcome: 'cancelled' };
};

/** 会话内 todo 卡稳定 id，重复 update_plan 由 renderer 就地合并。 */
export const CURSOR_TODOS_TOOL_USE_ID = 'cursor-todos';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function normalizeCursorTodoStatus(value: unknown): CursorTodoStatus {
  if (value === 'pending' || value === 'in_progress' || value === 'completed' || value === 'cancelled') {
    return value;
  }
  if (value === 'inProgress' || value === 'running') return 'in_progress';
  return 'pending';
}

export function parseCursorTodos(value: unknown): CursorTodoItem[] {
  if (!Array.isArray(value)) return [];
  const out: CursorTodoItem[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const id = readString(item.id)?.trim();
    const content = readString(item.content)?.trim();
    if (!id || !content) continue;
    out.push({
      id,
      content,
      status: normalizeCursorTodoStatus(item.status),
    });
  }
  return out;
}

export function parseAskQuestionParams(params: unknown): CursorAskQuestionParams | null {
  if (!isRecord(params)) return null;
  const toolCallId = readString(params.toolCallId)?.trim();
  if (!toolCallId) return null;
  const rawQuestions = Array.isArray(params.questions) ? params.questions : [];
  const questions: CursorAskQuestionItem[] = [];
  for (const q of rawQuestions) {
    if (!isRecord(q)) continue;
    const id = readString(q.id)?.trim();
    const prompt = readString(q.prompt)?.trim();
    if (!id || !prompt) continue;
    const options: CursorAskQuestionOption[] = [];
    if (Array.isArray(q.options)) {
      for (const opt of q.options) {
        if (!isRecord(opt)) continue;
        const optId = readString(opt.id)?.trim();
        const label = readString(opt.label)?.trim();
        if (!optId || !label) continue;
        options.push({ id: optId, label });
      }
    }
    questions.push({
      id,
      prompt,
      options,
      allowMultiple: q.allowMultiple === true,
    });
  }
  if (questions.length === 0) return null;
  return {
    toolCallId,
    title: readString(params.title),
    questions,
  };
}

export function toAskUserQuestionRequest(
  requestId: string,
  params: CursorAskQuestionParams,
): {
  kind: 'ask_user_question';
  requestId: string;
  questions: AskUserQuestionItem[];
} {
  return {
    kind: 'ask_user_question',
    requestId,
    questions: params.questions.map((q) => ({
      question: q.prompt,
      header: params.title,
      options: q.options.map((o) => ({ label: o.label })),
      multiSelect: q.allowMultiple === true,
    })),
  };
}

function labelsFromAnswer(answer: string | undefined, multiSelect: boolean): string[] {
  if (!answer) return [];
  if (!multiSelect) return [answer];
  try {
    const parsed = JSON.parse(answer) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
    }
  } catch {
    // fall through — treat as single freeform
  }
  return answer.trim() ? [answer] : [];
}

export function askQuestionResponseFromDecision(
  decision: InteractionDecision,
  params: CursorAskQuestionParams,
): CursorAskQuestionResponse {
  if (decision.kind !== 'ask_user_question') {
    return { outcome: { outcome: 'cancelled' } };
  }
  const answers = decision.answers ?? {};
  const mapped: CursorAskQuestionAnswer[] = [];
  for (const q of params.questions) {
    const raw = answers[q.prompt] ?? answers[q.id];
    const labels = labelsFromAnswer(raw, q.allowMultiple === true);
    if (labels.length === 0) continue;
    const byLabel = new Map(q.options.map((o) => [o.label, o.id]));
    const selectedOptionIds: string[] = [];
    const freeformParts: string[] = [];
    for (const label of labels) {
      const id = byLabel.get(label);
      if (typeof id === 'string') {
        selectedOptionIds.push(id);
      } else if (label.trim()) {
        freeformParts.push(label.trim());
      }
    }
    const freeformText = freeformParts.length > 0 ? freeformParts.join('\n') : undefined;
    if (selectedOptionIds.length === 0 && !freeformText) continue;
    const entry: CursorAskQuestionAnswer = { questionId: q.id, selectedOptionIds };
    if (freeformText) entry.freeformText = freeformText;
    mapped.push(entry);
  }
  if (mapped.length === 0) {
    return { outcome: { outcome: 'skipped', reason: 'no answers' } };
  }
  return { outcome: { outcome: 'answered', answers: mapped } };
}

export function parseCreatePlanParams(params: unknown): CursorCreatePlanParams | null {
  if (!isRecord(params)) return null;
  const toolCallId = readString(params.toolCallId)?.trim();
  if (!toolCallId) return null;
  const plan = readString(params.plan) ?? '';
  const name = readString(params.name);
  const overview = readString(params.overview);
  const todos = parseCursorTodos(params.todos);
  const phases = Array.isArray(params.phases)
    ? params.phases
        .map((phase) => {
          if (!isRecord(phase)) return null;
          const phaseName = readString(phase.name)?.trim();
          if (!phaseName) return null;
          return { name: phaseName, todos: parseCursorTodos(phase.todos) };
        })
        .filter((p): p is { name: string; todos: CursorTodoItem[] } => p !== null)
    : undefined;
  if (!plan.trim() && !name && !overview && todos.length === 0) return null;
  return {
    toolCallId,
    name,
    overview,
    plan,
    todos,
    isProject: params.isProject === true,
    phases,
  };
}

/** 审批卡正文：优先 markdown plan，否则拼 name/overview/todos。 */
export function formatCreatePlanReviewText(params: CursorCreatePlanParams): string {
  const trimmed = params.plan.trim();
  if (trimmed) return trimmed;
  const parts: string[] = [];
  if (params.name?.trim()) parts.push(`# ${params.name.trim()}`);
  if (params.overview?.trim()) parts.push(params.overview.trim());
  if (params.todos.length > 0) {
    parts.push(
      params.todos
        .map((t, i) => `${i + 1}. ${t.content}`)
        .join('\n'),
    );
  }
  return parts.join('\n\n').trim() || 'Plan';
}

export function toPlanReviewRequest(
  requestId: string,
  params: CursorCreatePlanParams,
): {
  kind: 'plan_review';
  requestId: string;
  plan: string;
} {
  return {
    kind: 'plan_review',
    requestId,
    plan: formatCreatePlanReviewText(params),
  };
}

export function createPlanResponseFromDecision(
  decision: InteractionDecision,
): CursorCreatePlanResponse {
  if (decision.kind !== 'plan_review') {
    return { outcome: { outcome: 'cancelled' } };
  }
  if (decision.behavior === 'allow') {
    return { outcome: { outcome: 'accepted' } };
  }
  if (decision.dismissed) {
    return { outcome: { outcome: 'cancelled' } };
  }
  return {
    outcome: {
      outcome: 'rejected',
      reason: decision.reason?.trim() || 'User rejected plan',
    },
  };
}

export function parseUpdateTodosParams(params: unknown): CursorUpdateTodosParams | null {
  if (!isRecord(params)) return null;
  const toolCallId = readString(params.toolCallId)?.trim() || CURSOR_TODOS_TOOL_USE_ID;
  const todos = parseCursorTodos(params.todos);
  if (todos.length === 0 && params.merge !== true) return null;
  return {
    toolCallId,
    todos,
    merge: params.merge === true,
  };
}

export function mergeCursorTodos(
  existing: readonly CursorTodoItem[],
  incoming: readonly CursorTodoItem[],
  merge: boolean,
): CursorTodoItem[] {
  if (!merge) return incoming.map((t) => ({ ...t }));
  const byId = new Map(existing.map((t) => [t.id, { ...t }]));
  for (const item of incoming) {
    byId.set(item.id, { ...item });
  }
  return Array.from(byId.values());
}

/** messageRender 只认 pending/in_progress/completed；cancelled → completed 以免卡片丢项。 */
function toRenderStatus(status: CursorTodoStatus): 'pending' | 'in_progress' | 'completed' {
  if (status === 'cancelled') return 'completed';
  return status;
}

/**
 * 发出与 Codex update_plan 同形的 tool_use，供 TodoListCard / messageRender 复用。
 * 使用稳定 toolUseId，便于后续 merge 快照就地更新。
 */
export function todosToUpdatePlanEvents(
  todos: readonly CursorTodoItem[],
  opts?: { toolCallId?: string; source?: 'cursor' },
): AgentEvent[] {
  const toolUseId = opts?.toolCallId?.trim() || CURSOR_TODOS_TOOL_USE_ID;
  const source = opts?.source ?? 'cursor';
  const plan = todos.map((t) => ({
    id: t.id,
    content: t.content,
    status: toRenderStatus(t.status),
  }));
  return [
    {
      type: 'tool_use',
      data: {
        toolUseId,
        toolName: 'update_plan',
        input: { plan, todos: plan },
      },
      source,
    },
  ];
}

export function updateTodosAcceptedResponse(
  todos: readonly CursorTodoItem[],
): CursorUpdateTodosResponse {
  return {
    outcome: {
      outcome: 'accepted',
      todos: todos.map((t) => ({ ...t })),
    },
  };
}

// ── cursor/task ──────────────────────────────────────────────────────────────

export type CursorSubagentType =
  | 'unspecified'
  | 'computer_use'
  | 'explore'
  | 'video_review'
  | 'browser_use'
  | 'shell'
  | 'vm_setup_helper'
  | { custom: string };

export interface CursorTaskParams {
  toolCallId: string;
  description: string;
  prompt: string;
  subagentType: CursorSubagentType;
  model?: string;
  agentId?: string;
  durationMs?: number;
  /** 官方 schema 未列；防御式支持 start/update 显式状态。 */
  status?: string;
}

export type CursorTaskResponse = {
  outcome:
    | { outcome: 'completed'; agentId?: string; durationMs?: number }
    | { outcome: 'rejected'; reason?: string }
    | { outcome: 'cancelled' };
};

export function formatCursorSubagentType(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (isRecord(value)) {
    const custom = readString(value.custom)?.trim();
    return custom || undefined;
  }
  return undefined;
}

export function parseCursorTaskParams(params: unknown): CursorTaskParams | null {
  if (!isRecord(params)) return null;
  const toolCallId = readString(params.toolCallId)?.trim();
  if (!toolCallId) return null;
  const description = readString(params.description)?.trim() ?? '';
  const prompt = readString(params.prompt) ?? '';
  const subagentRaw = params.subagentType;
  let subagentType: CursorSubagentType = 'unspecified';
  if (typeof subagentRaw === 'string' && subagentRaw.trim()) {
    subagentType = subagentRaw.trim() as CursorSubagentType;
  } else if (isRecord(subagentRaw)) {
    const custom = readString(subagentRaw.custom)?.trim();
    if (custom) subagentType = { custom };
  }
  const durationRaw = params.durationMs;
  const durationMs =
    typeof durationRaw === 'number' && Number.isFinite(durationRaw) ? durationRaw : undefined;
  return {
    toolCallId,
    description,
    prompt,
    subagentType,
    model: readString(params.model)?.trim() || undefined,
    agentId: readString(params.agentId)?.trim() || undefined,
    ...(durationMs !== undefined ? { durationMs } : {}),
    status: readString(params.status)?.trim() || undefined,
  };
}

/**
 * 推断任务卡状态。官方 `cursor/task` 多为 completion-only；
 * 缺 status 且带 durationMs → completed；全缺 → completed（对齐 HAPI/happier）；
 * 显式 running/started 等 → running，便于未来 start/update 样本。
 */
export function inferCursorTaskStatus(params: CursorTaskParams): AgentTaskStatus {
  const raw = params.status?.trim().toLowerCase();
  if (raw) {
    if (
      raw === 'running' ||
      raw === 'in_progress' ||
      raw === 'inprogress' ||
      raw === 'pending' ||
      raw === 'started'
    ) {
      return 'running';
    }
    if (raw === 'failed' || raw === 'error') return 'failed';
    if (raw === 'cancelled' || raw === 'canceled' || raw === 'stopped' || raw === 'killed') {
      return 'stopped';
    }
    if (raw === 'completed' || raw === 'done' || raw === 'success') return 'completed';
  }
  if (typeof params.durationMs === 'number') return 'completed';
  return 'completed';
}

export function isCursorTaskTerminalStatus(status: AgentTaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'stopped';
}

/**
 * 展示用 taskId：优先 agentId（有则更稳）。
 * running Map / 终态机一律用 toolCallId，避免 start 无 agentId、done 带 agentId 时清不掉。
 */
export function cursorTaskStableId(params: CursorTaskParams): string {
  return params.agentId?.trim() || params.toolCallId;
}

/**
 * 映射为共享 Task 工具卡 + agent_task_update。
 * alreadyEmittedToolUse：同一 toolCallId 已发过 tool_use 时只补 update（避免重复卡）。
 */
export function cursorTaskToEvents(
  params: CursorTaskParams,
  opts?: { alreadyEmittedToolUse?: boolean; source?: 'cursor' },
): AgentEvent[] {
  const source = opts?.source ?? 'cursor';
  const taskId = cursorTaskStableId(params);
  const status = inferCursorTaskStatus(params);
  const subagentType = formatCursorSubagentType(params.subagentType) ?? 'unspecified';
  const title = params.description.trim() || subagentType;
  const events: AgentEvent[] = [];
  if (!opts?.alreadyEmittedToolUse) {
    events.push({
      type: 'tool_use',
      data: {
        toolUseId: params.toolCallId,
        toolName: 'Task',
        input: {
          description: title,
          prompt: params.prompt,
          subagent_type: subagentType,
          ...(params.model ? { model: params.model } : {}),
          ...(params.agentId ? { agentId: params.agentId } : {}),
          ...(params.durationMs !== undefined ? { durationMs: params.durationMs } : {}),
        },
      },
      source,
    });
  }
  // 持久化标记：`persistSubagentTaskUpdate` 只落带有效 observation 的更新，
  // 没有它 Cursor 子任务只活在当前事件流里，刷新 / 重启就从 Subagent 工作区消失。
  //
  // logicalSubagentId 用 **toolCallId** 而不是展示用的 `taskId`：后者优先取
  // agentId，而 agentId 在 start 时常常没有、done 时才有（见 cursorTaskStableId
  // 的注释），拿它当持久身份会让同一个子任务的 spawn 与 terminal 落成两条记录。
  // agentId 作为对端 run id 只在 spawn 上报一次（契约要求）。
  const logicalSubagentId = params.toolCallId;
  const agentId = params.agentId?.trim();
  const aliases = taskId !== logicalSubagentId ? [taskId] : undefined;
  const observation = (kind: 'spawn' | 'progress' | 'terminal'): SubagentObservation => ({
    kind,
    logicalSubagentId,
    parentToolUseId: params.toolCallId,
    ...(aliases ? { identityAliases: aliases } : {}),
    ...(kind === 'spawn' && agentId ? { providerRunIds: [agentId] } : {}),
  });
  const firstEmit = !opts?.alreadyEmittedToolUse;
  const terminal = isCursorTaskTerminalStatus(status);
  const update: AgentTaskUpdateEventData = {
    provider: 'cursor',
    taskId,
    parentToolUseId: params.toolCallId,
    status,
    title,
    // 首次出现一律先 spawn（只有 spawn 能建持久 run）；之后按终态与否分流。
    subagentObservation: observation(firstEmit ? 'spawn' : terminal ? 'terminal' : 'progress'),
    ...(params.prompt.trim() ? { description: params.prompt } : {}),
    ...(params.model ? { model: params.model } : {}),
    taskType: subagentType,
    ...(typeof params.durationMs === 'number'
      ? { usage: { durationMs: params.durationMs }, summary: status === 'completed' ? 'completed' : undefined }
      : {}),
    raw: {
      subagentType: params.subagentType,
      agentId: params.agentId,
      durationMs: params.durationMs,
      status: params.status,
    },
  };
  events.push({ type: 'agent_task_update', data: update, source });
  // 首次出现就已经是终态（快子任务只报一次 done）：spawn 建了 run 还得把它关掉，
  // 否则持久层永远留一条 running。
  if (firstEmit && terminal) {
    events.push({
      type: 'agent_task_update',
      data: { ...update, subagentObservation: observation('terminal') },
      source,
    });
  }
  if (status === 'completed' || status === 'failed' || status === 'stopped') {
    const isError = status === 'failed';
    const fullText =
      status === 'completed'
        ? params.prompt.trim() || title || 'completed'
        : status;
    events.push({
      type: 'tool_result_full',
      data: { toolUseId: params.toolCallId, fullText, isError },
      source,
    });
    events.push({
      type: 'tool_result',
      data: { summary: status, toolUseIds: [params.toolCallId] },
      source,
    });
  }
  return events;
}

export function cursorTaskAcceptedResponse(params: CursorTaskParams): CursorTaskResponse {
  return {
    outcome: {
      outcome: 'completed',
      ...(params.agentId ? { agentId: params.agentId } : { agentId: params.toolCallId }),
      ...(typeof params.durationMs === 'number' ? { durationMs: params.durationMs } : {}),
    },
  };
}

export function stopCursorTaskEvents(
  tasks: ReadonlyMap<string, { toolCallId: string; title?: string }>,
  reason: string,
): AgentEvent[] {
  const events: AgentEvent[] = [];
  for (const [taskId, meta] of tasks) {
    events.push({
      type: 'agent_task_update',
      data: {
        provider: 'cursor',
        taskId,
        parentToolUseId: meta.toolCallId,
        status: 'stopped',
        ...(meta.title ? { title: meta.title } : {}),
        summary: reason,
      } satisfies AgentTaskUpdateEventData,
      source: 'cursor',
    });
  }
  return events;
}

// ── cursor/generate_image ────────────────────────────────────────────────────

export interface CursorGenerateImageParams {
  toolCallId: string;
  description: string;
  filePath?: string;
  referenceImagePaths?: string[];
  /** 防御式：部分实现可能在通知里带 base64 / data URL。 */
  imageData?: string;
}

export type CursorGenerateImageResponse = {
  outcome:
    | { outcome: 'generated'; filePath: string; imageData?: string }
    | { outcome: 'rejected'; reason?: string }
    | { outcome: 'cancelled' };
};

export function parseCursorGenerateImageParams(
  params: unknown,
): CursorGenerateImageParams | null {
  if (!isRecord(params)) return null;
  const toolCallId = readString(params.toolCallId)?.trim();
  if (!toolCallId) return null;
  const description = readString(params.description)?.trim() ?? '';
  const filePath = readString(params.filePath)?.trim() || undefined;
  const imageData = readString(params.imageData)?.trim() || undefined;
  const refs: string[] = [];
  if (Array.isArray(params.referenceImagePaths)) {
    for (const item of params.referenceImagePaths) {
      const p = readString(item)?.trim();
      if (p) refs.push(p);
    }
  }
  if (!filePath && !imageData) {
    // 仍解析成功但无媒体 —— 调用方返回 rejected，不崩溃。
    return { toolCallId, description, referenceImagePaths: refs.length ? refs : undefined };
  }
  return {
    toolCallId,
    description,
    ...(filePath ? { filePath } : {}),
    ...(imageData ? { imageData } : {}),
    ...(refs.length ? { referenceImagePaths: refs } : {}),
  };
}

function isUrlLikeImage(s: string): boolean {
  return /^(https?:|data:)/i.test(s);
}

/**
 * base64 / data URL 字符上限（约 15MiB 解码体积）。在拼 data: URL / 推事件前拦截，
 * 避免超大串进入主进程事件队列。
 */
export const MAX_CURSOR_GENERATE_IMAGE_DATA_CHARS = 22 * 1024 * 1024;

/** 路径是否落在允许根内（不做 realpath；主机侧再做实盘校验）。 */
export function isCursorGenerateImagePathUnderRoots(
  filePath: string,
  allowedRoots: readonly string[],
): boolean {
  if (!filePath || isUrlLikeImage(filePath)) return false;
  if (!isAbsolute(filePath)) return false;
  const resolved = resolve(filePath);
  for (const root of allowedRoots) {
    if (!root || !isAbsolute(root)) continue;
    const rootResolved = resolve(root);
    const rel = relative(rootResolved, resolved);
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return true;
  }
  return false;
}

/** 映射为共享 image(generation) 事件；缺媒体时返回空数组。 */
export function cursorGenerateImageToEvents(
  params: CursorGenerateImageParams,
  opts?: { source?: 'cursor' },
): AgentEvent[] {
  const source = opts?.source ?? 'cursor';
  const data: ImageEventData = {
    kind: 'generation',
    blockId: params.toolCallId,
    status: 'completed',
    ...(params.description ? { revisedPrompt: params.description } : {}),
  };
  if (params.filePath) {
    if (isUrlLikeImage(params.filePath)) data.url = params.filePath;
    else data.path = params.filePath;
  } else if (params.imageData) {
    data.url = params.imageData.startsWith('data:')
      ? params.imageData
      : `data:image/png;base64,${params.imageData}`;
  } else {
    return [];
  }
  return [{ type: 'image', data, source }];
}

/**
 * 在推事件 / ACK 前做轻量拒绝：缺媒体、超长 imageData、路径不在允许根。
 * 返回 null 表示可继续；否则为 rejected reason。
 */
export function preflightCursorGenerateImage(
  params: CursorGenerateImageParams,
  opts: { allowedRoots: readonly string[] },
): string | null {
  if (!params.filePath && !params.imageData) {
    return 'missing filePath/imageData';
  }
  if (params.imageData && params.imageData.length > MAX_CURSOR_GENERATE_IMAGE_DATA_CHARS) {
    return 'imageData exceeds size limit';
  }
  if (params.filePath && !isUrlLikeImage(params.filePath)) {
    if (!isCursorGenerateImagePathUnderRoots(params.filePath, opts.allowedRoots)) {
      return 'filePath outside allowed directories';
    }
  }
  // data: 塞在 filePath 里时也限长
  if (params.filePath?.startsWith('data:') && params.filePath.length > MAX_CURSOR_GENERATE_IMAGE_DATA_CHARS) {
    return 'filePath data URL exceeds size limit';
  }
  return null;
}

export function cursorGenerateImageAcceptedResponse(
  params: CursorGenerateImageParams,
): CursorGenerateImageResponse {
  if (params.filePath) {
    return {
      outcome: {
        outcome: 'generated',
        filePath: params.filePath,
        ...(params.imageData ? { imageData: params.imageData } : {}),
      },
    };
  }
  if (params.imageData) {
    return {
      outcome: {
        outcome: 'generated',
        filePath: `cursor-generated:${params.toolCallId}`,
        imageData: params.imageData,
      },
    };
  }
  return { outcome: { outcome: 'rejected', reason: 'missing filePath/imageData' } };
}
