/**
 * Cursor ACP vendor 扩展方法 ↔ Cindy InteractionRequest / AgentEvent。
 *
 *  - cursor/ask_question  → ask_user_question
 *  - cursor/create_plan   → plan_review
 *  - cursor/update_todos  → tool_use(update_plan)（复用 messageRender todo 卡）
 *
 * 协议形状以官方 docs + cursor-agent 实测为准；不进 agents/acp 标准面。
 */

import type { AgentEvent, AskUserQuestionItem, InteractionDecision } from '../../types/events.js';

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
