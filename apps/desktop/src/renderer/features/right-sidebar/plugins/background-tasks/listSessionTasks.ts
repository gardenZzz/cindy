/**
 * listSessionTasks —— 「后台任务」面板的任务枚举纯函数。
 *
 * 约束(与聊天流渲染层保持同口径,防止面板与卡片状态分叉):
 * - 工具识别 / update 配对口径 = MessageStream.buildRenderItems + findTaskUpdate:
 *   先 toolUseId 后 clientId 查 taskUpdates;tool_result 存在性 = toolUseId 查表
 *   命中,或紧邻其后的 tool_result 行(旧数据 toolUseId 缺失时的 adjacency 兜底)。
 * - 状态推导口径 = AgentTaskCard:update?.status 优先,无 update 时有结果为
 *   completed、无结果为 running。
 * - 孤儿 update(map 里有、消息窗口内配不到 toolCall)只在会话运行中列出
 *   (口径 = maker-shared/messageRender.appendOrphanAgentTasks 的 gating 注释:
 *   空闲态的孤儿是滑出分页窗口的陈旧残留,不得复播)。
 * - 纯函数:不触碰 store / transport / i18n;title 取不到任何来源时返回空串,
 *   由 UI 层用本地化兜底文案补齐。
 * - 本文件签名是并行开发契约,不得改动。
 */

import { isAgentTaskToolName } from '@cindy/maker-shared/agent-task';

import type { Message } from '@/lib/ccAgent.types';
import type { AgentTaskStatus, AgentTaskUpdate } from '@/lib/makerChatStore';

export interface SessionTaskItem {
  /** 稳定 key:taskId ?? toolUseId ?? clientId。 */
  key: string;
  taskId?: string;
  kind: 'workflow' | 'agent' | 'bash' | 'other';
  /** 标题链取不到任何来源时为 ''(UI 层负责 i18n 兜底)。 */
  title: string;
  status: AgentTaskStatus;
  provider: 'claude-code' | 'codex';
  update?: AgentTaskUpdate;
  toolCallClientId?: string;
  toolUseId?: string;
  /** 消息窗口内出现顺序;孤儿 update 排最后。 */
  orderIndex: number;
}

export interface SessionTaskLists {
  running: SessionTaskItem[];
  completed: SessionTaskItem[];
}

/** 标题截断上限与 AgentTaskCard 的标题链一致(96)。 */
const TITLE_MAX = 96;

/** update.taskType → 面板 kind 的既知词表;词表外的非空值一律归 'other',不隐藏。 */
const KNOWN_TASK_TYPE_KIND: Readonly<Record<string, SessionTaskItem['kind']>> = {
  local_workflow: 'workflow',
  local_agent: 'agent',
  local_bash: 'bash',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

/** 与 AgentTaskCard.readInputString 同口径:按 key 顺序取第一个非空白字符串。 */
function readInputString(input: unknown, keys: readonly string[]): string | undefined {
  if (!isRecord(input)) return undefined;
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

/** 与 AgentTaskCard.compactText 同口径:压平空白 + 截断加省略号。 */
function compactText(text: string | undefined, max: number): string | undefined {
  if (!text) return undefined;
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (!oneLine) return undefined;
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}…`;
}

interface ToolCallShape {
  toolName: string;
  toolInput: unknown;
  toolUseId: string | undefined;
}

/**
 * 从一条 tool_use 消息里抽 toolName / input / toolUseId。
 * DB 行(ccAgent.types.Message)形态:content = { toolName, input, toolUseId? }
 * (legacy 行 toolUseId 存在 content 里,口径 = mapServerMessages);store 侧
 * ChatMessage 形态是顶层 toolName / toolInput —— 两种形态并存,这里防御兼容,
 * 避免调用方喂哪一层的消息数组都不至于整表落空。
 */
function readToolCall(m: Message): ToolCallShape {
  const c = isRecord(m.content) ? m.content : undefined;
  const top = m as unknown as { toolName?: unknown; toolInput?: unknown };
  const toolName =
    typeof c?.toolName === 'string'
      ? c.toolName
      : typeof top.toolName === 'string'
        ? top.toolName
        : '';
  const toolInput = c && 'input' in c ? c.input : top.toolInput;
  const toolUseId =
    (typeof m.toolUseId === 'string' && m.toolUseId.length > 0 ? m.toolUseId : undefined) ??
    (typeof c?.toolUseId === 'string' && c.toolUseId.length > 0 ? c.toolUseId : undefined);
  return { toolName, toolInput, toolUseId };
}

/**
 * kind 推导:update.taskType 在既知词表内则以它为准;词表外非空值归 'other';
 * 缺失时按 toolName 回退(Workflow / 后台 Bash / Agent·Task·collab:*);
 * 孤儿(无 toolName)且无 taskType 时默认 'agent'(典型:codex collab 的
 * spawning tool-call 尚未送达)。
 */
function deriveKind(toolName: string | undefined, update: AgentTaskUpdate | undefined): SessionTaskItem['kind'] {
  const taskType = update?.taskType;
  if (taskType) return KNOWN_TASK_TYPE_KIND[taskType] ?? 'other';
  if (toolName === 'Workflow') return 'workflow';
  if (toolName === 'Bash') return 'bash';
  return 'agent';
}

/**
 * 标题链(口径 = AgentTaskCard):
 * - workflow:update.workflowName 优先;
 * - bash:update.title ?? description ?? command;
 * - 其余:update.title ?? description/task/name ?? prompt。
 */
function deriveTitle(
  kind: SessionTaskItem['kind'],
  update: AgentTaskUpdate | undefined,
  toolInput: unknown,
): string {
  if (kind === 'workflow') {
    return (
      compactText(
        update?.workflowName ??
          update?.title ??
          readInputString(toolInput, ['description', 'task', 'name']) ??
          readInputString(toolInput, ['prompt']),
        TITLE_MAX,
      ) ?? ''
    );
  }
  if (kind === 'bash') {
    return (
      compactText(
        update?.title ??
          readInputString(toolInput, ['description']) ??
          readInputString(toolInput, ['command']),
        TITLE_MAX,
      ) ?? ''
    );
  }
  return (
    compactText(
      update?.title ??
        readInputString(toolInput, ['description', 'task', 'name']) ??
        readInputString(toolInput, ['prompt']),
      TITLE_MAX,
    ) ?? ''
  );
}

/** 与 findTaskUpdate 同口径:先 toolUseId、后 clientId 查 map。 */
function findUpdate(
  taskUpdates: ReadonlyMap<string, AgentTaskUpdate> | undefined,
  toolUseId: string | undefined,
  clientId: string,
): AgentTaskUpdate | undefined {
  if (!taskUpdates) return undefined;
  if (toolUseId) {
    const byToolUseId = taskUpdates.get(toolUseId);
    if (byToolUseId) return byToolUseId;
  }
  return taskUpdates.get(clientId);
}

/** completed 区排序 key:updatedAt 解析失败/缺失一律视为无时间戳。 */
function completedTimestamp(item: SessionTaskItem): number | undefined {
  const iso = item.update?.updatedAt;
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * completed 区:按 update.updatedAt 倒序;无时间戳的(纯历史条目,update 只存活
 * 于 live 会话,缺失即更旧)排在有时间戳之后,组内按 orderIndex 倒序。
 */
function compareCompleted(a: SessionTaskItem, b: SessionTaskItem): number {
  const ta = completedTimestamp(a);
  const tb = completedTimestamp(b);
  if (ta !== undefined && tb !== undefined) return tb - ta || b.orderIndex - a.orderIndex;
  if (ta !== undefined) return -1;
  if (tb !== undefined) return 1;
  return b.orderIndex - a.orderIndex;
}

export function listSessionTasks(input: {
  messages: readonly Message[];
  taskUpdates: ReadonlyMap<string, AgentTaskUpdate> | undefined;
  isSessionStreaming: boolean;
}): SessionTaskLists {
  const { messages, taskUpdates, isSessionStreaming } = input;

  // Pass 0:tool_result 的 toolUseId 查表(与 buildRenderItems Pass 0 同口径)。
  const settledToolUseIds = new Set<string>();
  for (const m of messages) {
    if (m.role !== 'tool_result') continue;
    if (typeof m.toolUseId === 'string' && m.toolUseId.length > 0) {
      settledToolUseIds.add(m.toolUseId);
    }
  }

  const items: SessionTaskItem[] = [];
  // 已上榜任务的全部别名(toolUseId / taskId / parentToolUseId):
  // 同一任务的重复 toolCall 与孤儿补渲染都要据此去重,一行一个任务。
  const seenAliasKeys = new Set<string>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== 'tool_use') continue;
    const { toolName, toolInput, toolUseId } = readToolCall(msg);

    const isTaskTool = isAgentTaskToolName(toolName);
    const isWorkflowTool = toolName === 'Workflow';
    const isBackgroundBash =
      toolName === 'Bash' && isRecord(toolInput) && toolInput.run_in_background === true;
    // 其余工具(含前台 Bash)不是后台任务,不进列表。
    if (!isTaskTool && !isWorkflowTool && !isBackgroundBash) continue;

    const update = findUpdate(taskUpdates, toolUseId, msg.clientId);

    const aliasKeys = [toolUseId, update?.taskId, update?.parentToolUseId].filter(
      (k): k is string => typeof k === 'string' && k.length > 0,
    );
    // 同一任务已出过行(重复 toolCall / 别名撞车)→ 跳过,首行为准。
    if (aliasKeys.some((k) => seenAliasKeys.has(k))) continue;
    for (const k of aliasKeys) seenAliasKeys.add(k);

    // tool_result 存在性:toolUseId 查表命中为主路径;adjacency 兜底只认
    // 自身不带 toolUseId 的紧邻结果行(旧数据形态)—— 带 toolUseId 的结果行
    // 归属已由查表裁决,不得把别的工具的结果算到本行头上。
    let settled = toolUseId !== undefined && settledToolUseIds.has(toolUseId);
    for (let j = i + 1; !settled && j < messages.length && messages[j].role === 'tool_result'; j++) {
      const resultToolUseId = messages[j].toolUseId;
      if (typeof resultToolUseId !== 'string' || resultToolUseId.length === 0) settled = true;
    }

    const kind = deriveKind(toolName, update);
    const status: AgentTaskStatus = update?.status ?? (settled ? 'completed' : 'running');
    const provider: SessionTaskItem['provider'] =
      update?.provider ?? (toolName.startsWith('collab:') ? 'codex' : 'claude-code');

    items.push({
      key: update?.taskId ?? toolUseId ?? msg.clientId,
      ...(update?.taskId ? { taskId: update.taskId } : {}),
      kind,
      title: deriveTitle(kind, update, toolInput),
      status,
      provider,
      ...(update ? { update } : {}),
      toolCallClientId: msg.clientId,
      ...(toolUseId ? { toolUseId } : {}),
      orderIndex: i,
    });
  }

  // 孤儿 update:仅会话运行中列出(LIVE 占位;空闲态是陈旧残留,不复播)。
  // map 按 taskId + parentToolUseId 多 key 存同一 update,按 taskId 去重。
  if (isSessionStreaming && taskUpdates) {
    const seenTaskIds = new Set<string>();
    let orphanOrder = messages.length;
    for (const update of taskUpdates.values()) {
      const primaryKey = update.parentToolUseId ?? update.taskId;
      if (
        seenTaskIds.has(update.taskId) ||
        seenAliasKeys.has(primaryKey) ||
        seenAliasKeys.has(update.taskId)
      ) {
        continue;
      }
      seenTaskIds.add(update.taskId);
      const kind = deriveKind(undefined, update);
      items.push({
        key: update.taskId,
        taskId: update.taskId,
        kind,
        title: deriveTitle(kind, update, undefined),
        status: update.status,
        provider: update.provider,
        update,
        orderIndex: orphanOrder++,
      });
    }
  }

  // 分区:running 按启动(出现)顺序升序;终态(completed/failed/stopped)按
  // 完成时间倒序 —— 对齐官方 Background tasks 面板的两区排序。
  const running = items
    .filter((it) => it.status === 'running')
    .sort((a, b) => a.orderIndex - b.orderIndex);
  const completed = items.filter((it) => it.status !== 'running').sort(compareCompleted);
  return { running, completed };
}
