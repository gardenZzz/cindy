/**
 * BackgroundTasksBody —— 「后台任务」tab 的内容区。
 *
 * 两个视图:
 *  - 列表:Running / Completed 两分区(排序由 listSessionTasks 保证:running 按
 *    启动升序、completed 按完成倒序),行 = kind 图标 + 状态图标 + 标题 + meta
 *    (状态 · 时长 · tokens · 工具调用),running 的 claude-code 任务行尾给 Stop。
 *  - workflow 详情:返回按钮 + 头部(标题 + Stop)+ WorkflowProgressTree 逐 agent
 *    进度树。
 *
 * 数据约束:
 *  - 事件源:makerChatStore 按 sessionId 订阅,快照 getter 只挑
 *    messages / taskUpdates / isStreaming 三个引用比对缓存 —— 不走
 *    useCCAgentChat 的重快照路径,其他字段(流式文本等)高频变更不触发重渲。
 *  - 面板不可见(非激活 tab / 壳子隐藏)时订阅挂空,恢复可见时重订阅自动补读。
 *  - 快照水合:挂载时对本机会话调一次 listSessionBackgroundTasks 经
 *    seedBackgroundTaskSnapshots 补存量(与 useBackgroundBashTasks 同口径,只复用
 *    store 公开函数);device-link 远程会话跳过(main 拿不到 handle,快照必空)。
 *  - wf 文件辅源:详情视图挂载时拉一次 getWorkflowProgressFor,任务从 running 翻
 *    终态时再拉一次;不轮询。远程/老被控端自动降级返回 null。
 *  - 停止:gating = running + claude-code + 有 taskId + 非远程会话;在飞防连点、
 *    失败静默,终态交给 task_notification 事件流收口(同 AgentTaskCard 口径)。
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle,
  ArrowLeft,
  Bot,
  CheckCircle2,
  CircleDashed,
  CircleStop,
  ListTodo,
  LoaderCircle,
  Square,
  SquareTerminal,
  Workflow,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';
import { makerChatStore, EMPTY_TASK_UPDATES } from '@/lib/makerChatStore';
import type { AgentTaskUpdate, ChatMessage } from '@/lib/makerChatStore';
import {
  getWorkflowProgressFor,
  isRemoteSession,
  listSessionBackgroundTasksFor,
} from '@/lib/makerTransport';
import { formatCompactTokens } from '@/lib/usageFormat';
import type { Message } from '@/lib/ccAgent.types';
import type { WorkflowProgress } from '../../../../../shared/workflow-progress';
import type { TabKindHostContext } from '../../types';
import type { BackgroundTasksState } from './index';
import { listSessionTasks, type SessionTaskItem } from './listSessionTasks';
import {
  buildWorkflowTreeModel,
  isTerminalWorkflowFileStatus,
  workflowAgentVisualState,
} from './workflowProgressModel';
import { WorkflowProgressTree } from './WorkflowProgressTree';
import { requestChatTaskFocus } from './chatTaskFocusIntent';

// ---------------------------------------------------------------------------
// store 订阅(轻量选择器)
// ---------------------------------------------------------------------------

interface SessionTaskInputs {
  messages: ChatMessage[];
  taskUpdates: ReadonlyMap<string, AgentTaskUpdate>;
  isStreaming: boolean;
}

const EMPTY_MESSAGES: ChatMessage[] = [];
/** 无 sessionId 时的稳定空快照(useSyncExternalStore 要求引用稳定)。 */
const EMPTY_INPUTS: SessionTaskInputs = {
  messages: EMPTY_MESSAGES,
  taskUpdates: EMPTY_TASK_UPDATES,
  isStreaming: false,
};

/**
 * 订阅当前会话的 (messages, taskUpdates, isStreaming) 三元组。
 * paused=true(面板不可见)时订阅挂空 —— 不再接收通知;恢复时 subscribe 引用
 * 变化触发 React 重订阅并重读快照,数据自动追平,无需额外刷新逻辑。
 */
function useSessionTaskInputs(sessionId: string | null, paused: boolean): SessionTaskInputs {
  const cacheRef = useRef<{
    messages: ChatMessage[];
    taskUpdates: ReadonlyMap<string, AgentTaskUpdate>;
    isStreaming: boolean;
    snapshot: SessionTaskInputs;
  } | null>(null);

  const subscribeStore = useCallback(
    (cb: () => void) => {
      if (!sessionId || paused) return () => {};
      return makerChatStore.subscribe(sessionId, cb);
    },
    [sessionId, paused],
  );

  const getInputs = useCallback((): SessionTaskInputs => {
    if (!sessionId) return EMPTY_INPUTS;
    const s = makerChatStore.getSnapshot(sessionId);
    const cached = cacheRef.current;
    // 三个引用全等 → 返回缓存快照,React Object.is 短路,避免无关字段变更引发重渲。
    if (
      cached &&
      cached.messages === s.messages &&
      cached.taskUpdates === s.taskUpdates &&
      cached.isStreaming === s.isStreaming
    ) {
      return cached.snapshot;
    }
    const snapshot: SessionTaskInputs = {
      messages: s.messages,
      // taskUpdates 类型上可缺省(历史快照形态),缺省回落稳定空 Map。
      taskUpdates: s.taskUpdates ?? EMPTY_TASK_UPDATES,
      isStreaming: s.isStreaming,
    };
    cacheRef.current = { ...snapshot, snapshot };
    return snapshot;
  }, [sessionId]);

  return useSyncExternalStore(subscribeStore, getInputs);
}

// ---------------------------------------------------------------------------
// 展示辅助
// ---------------------------------------------------------------------------

/** kind → 行首图标(与聊天卡片的视觉词汇一致)。 */
function kindIcon(kind: SessionTaskItem['kind']): LucideIcon {
  if (kind === 'workflow') return Workflow;
  if (kind === 'bash') return SquareTerminal;
  if (kind === 'agent') return Bot;
  return CircleDashed;
}

/** 标题兜底(listSessionTasks 契约:取不到来源时 title='',由 UI 补 i18n 文案)。 */
function fallbackTitleKey(kind: SessionTaskItem['kind']): string {
  if (kind === 'workflow') return 'chat.agentTask.provider.workflow';
  if (kind === 'bash') return 'chat.agentTask.provider.shell';
  return 'chat.agentTask.emptyTitle';
}

/** status → 状态图标(running 由 Spinner 负责旋转)。 */
function statusIcon(status: string): LucideIcon {
  if (status === 'completed') return CheckCircle2;
  if (status === 'failed') return AlertCircle;
  if (status === 'stopped') return CircleStop;
  return LoaderCircle;
}

/** 毫秒 → 紧凑时长文案(与 AgentTaskCard 同口径;该实现未导出,此处内联)。 */
function formatDuration(ms: number | undefined): string | undefined {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return undefined;
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
}

/** workflow 行副标题:workflow_agent 条目 done/error 计数 / 总数。 */
function workflowAgentCounts(
  update: AgentTaskUpdate | undefined,
): { done: number; total: number } | null {
  const entries = update?.workflowProgress;
  if (!entries || entries.length === 0) return null;
  let total = 0;
  let done = 0;
  for (const entry of entries) {
    if (entry.type !== 'workflow_agent') continue;
    total += 1;
    // 收口判定走 workflowAgentVisualState 归一(与方块条同一词表源,
    // done/completed 与 error/failed/stopped/killed 全算已收口)。
    const visual = workflowAgentVisualState(entry.state);
    if (visual === 'done' || visual === 'failed') done += 1;
  }
  return total > 0 ? { done, total } : null;
}

/** 停止按钮 gating(与 AgentTaskCard 同口径):running + claude-code + 有 taskId + 非远程。 */
function canStopItem(item: SessionTaskItem, sessionId: string | null): boolean {
  return (
    item.status === 'running' &&
    item.provider === 'claude-code' &&
    Boolean(item.update?.taskId) &&
    Boolean(sessionId) &&
    !(sessionId && isRemoteSession(sessionId))
  );
}

/** 停止按钮:在飞防连点、失败静默,状态翻转由事件流收口(不改本地状态)。 */
function StopButton({ sessionId, taskId }: { sessionId: string; taskId: string }) {
  const { t } = useTranslation();
  const [stopping, setStopping] = useState(false);
  const handleStop = useCallback(
    (e: MouseEvent) => {
      // 行点击(进详情 / 聊天定位)不该被停止按钮触发。
      e.stopPropagation();
      const api = window.electronAPI?.maker;
      if (!api?.stopAgentTask || stopping) return;
      setStopping(true);
      void api
        .stopAgentTask(sessionId, taskId)
        .catch(() => {
          // 静默:真失败时状态仍是 running,按钮保留可重试。
        })
        .finally(() => setStopping(false));
    },
    [sessionId, taskId, stopping],
  );
  return (
    <button
      type="button"
      onClick={handleStop}
      disabled={stopping}
      aria-label={t('rightSidebar.backgroundTasks.stop')}
      title={t('rightSidebar.backgroundTasks.stop')}
      className={cn(
        'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]',
        stopping && 'cursor-default opacity-50',
      )}
    >
      <Square size={12} aria-hidden="true" />
    </button>
  );
}

// ---------------------------------------------------------------------------
// 列表行
// ---------------------------------------------------------------------------

function TaskRow({
  item,
  sessionId,
  onOpenWorkflow,
}: {
  item: SessionTaskItem;
  sessionId: string | null;
  onOpenWorkflow: (key: string) => void;
}) {
  const { t } = useTranslation();
  const KindIcon = kindIcon(item.kind);
  const StatusIcon = statusIcon(item.status);
  const running = item.status === 'running';

  // meta:状态 · 时长 · tokens · 工具调用(缺项省略);workflow 行前置 agent 进度摘要。
  const metaParts = useMemo(() => {
    const parts: string[] = [];
    const knownStatus =
      item.status === 'running' ||
      item.status === 'completed' ||
      item.status === 'failed' ||
      item.status === 'stopped';
    if (knownStatus) parts.push(t(`chat.agentTask.status.${item.status}`));
    if (item.kind === 'workflow') {
      const counts = workflowAgentCounts(item.update);
      if (counts) {
        parts.push(
          t('rightSidebar.backgroundTasks.progressSummary', {
            done: counts.done,
            total: counts.total,
          }),
        );
      }
    }
    const usage = item.update?.usage;
    const duration = formatDuration(usage?.durationMs);
    if (duration) parts.push(duration);
    if (typeof usage?.totalTokens === 'number') {
      parts.push(
        t('rightSidebar.backgroundTasks.tokens', {
          value: formatCompactTokens(usage.totalTokens),
        }),
      );
    }
    if (typeof usage?.toolUses === 'number') {
      parts.push(t('chat.agentTask.toolUses', { count: usage.toolUses }));
    }
    return parts;
  }, [item, t]);

  const handleClick = useCallback(() => {
    if (item.kind === 'workflow') {
      onOpenWorkflow(item.key);
      return;
    }
    // 非 workflow 行:发聊天定位意图(消费端接线归后续阶段,当前无订阅者时 no-op)。
    if (sessionId && item.toolCallClientId) {
      requestChatTaskFocus(sessionId, item.toolCallClientId);
    }
  }, [item, sessionId, onOpenWorkflow]);

  return (
    <div className="flex items-start gap-1">
      <button
        type="button"
        onClick={handleClick}
        className="flex min-w-0 flex-1 items-start gap-2 rounded-[8px] px-2 py-1.5 text-left transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
      >
        <span className="mt-[1px] inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--surface-chip)] text-[var(--text-secondary)]">
          <KindIcon size={12} aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <Spinner
              icon={StatusIcon}
              size={13}
              spinning={running}
              className={cn(
                'shrink-0 text-[var(--text-secondary)]',
                item.status === 'failed' && 'text-[var(--error-fg)]',
              )}
            />
            <span className="truncate text-13 leading-5 text-[var(--text-primary)]">
              {item.title || t(fallbackTitleKey(item.kind))}
            </span>
          </span>
          {metaParts.length > 0 && (
            <span className="mt-0.5 block truncate text-11 leading-4 text-[var(--text-tertiary)]">
              {metaParts.join(' · ')}
            </span>
          )}
        </span>
      </button>
      {canStopItem(item, sessionId) && sessionId && item.update?.taskId && (
        <div className="pt-1.5">
          <StopButton sessionId={sessionId} taskId={item.update.taskId} />
        </div>
      )}
    </div>
  );
}

function SectionHeader({ label }: { label: string }) {
  return (
    <div className="px-2 pb-1 pt-3 text-11 font-medium uppercase tracking-[0.5px] text-[var(--text-tertiary)]">
      {label}
    </div>
  );
}

// ---------------------------------------------------------------------------
// workflow 详情
// ---------------------------------------------------------------------------

function WorkflowDetail({
  item,
  sessionId,
  onBack,
}: {
  item: SessionTaskItem;
  sessionId: string | null;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const taskId = item.update?.taskId ?? item.taskId ?? null;
  const [fileProgress, setFileProgress] = useState<WorkflowProgress | null>(null);

  // wf 文件辅源:挂载读一次;任务翻终态(isTerminal false→true 触发 effect 重跑)
  // 再读一次。任务已终态而文件快照还停在运行中(终态事件先于终局落盘)时做有界
  // 重试(至多 2 次,1.5s 间隔),文件收口即停 —— 仍不是轮询。远程会话/老被控端
  // getWorkflowProgressFor 内部降级 null,读不到时详情树退化为事件流数据。
  const isTerminal = item.status !== 'running';
  useEffect(() => {
    if (!sessionId || !taskId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = (retriesLeft: number) => {
      void getWorkflowProgressFor(sessionId, taskId)
        .then((progress) => {
          if (disposed) return;
          if (progress) setFileProgress(progress);
          const settled = isTerminalWorkflowFileStatus(progress?.status);
          if (isTerminal && !settled && retriesLeft > 0) {
            timer = setTimeout(() => read(retriesLeft - 1), 1500);
          }
        })
        .catch(() => {
          // 静默:文件辅源缺失时详情树退化为事件流数据。
        });
    };
    read(isTerminal ? 2 : 0);
    return () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [sessionId, taskId, isTerminal]);

  const model = useMemo(
    () =>
      buildWorkflowTreeModel({
        entries: item.update?.workflowProgress,
        fileProgress,
        taskStatus: item.status,
        usage: item.update?.usage,
      }),
    [item.update?.workflowProgress, fileProgress, item.status, item.update?.usage],
  );

  const title = item.update?.workflowName ?? (item.title || t(fallbackTitleKey(item.kind)));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--border-default)] px-2 py-1.5">
        <button
          type="button"
          onClick={onBack}
          aria-label={t('rightSidebar.backgroundTasks.back')}
          title={t('rightSidebar.backgroundTasks.back')}
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
        >
          <ArrowLeft size={14} aria-hidden="true" />
        </button>
        <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--surface-chip)] text-[var(--text-secondary)]">
          <Workflow size={12} aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1 truncate text-13 font-medium leading-5 text-[var(--text-primary)]">
          {title}
        </span>
        {canStopItem(item, sessionId) && sessionId && item.update?.taskId && (
          <StopButton sessionId={sessionId} taskId={item.update.taskId} />
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {model ? (
          <WorkflowProgressTree model={model} />
        ) : (
          <div className="px-2 py-6 text-center text-12 text-[var(--text-tertiary)]">
            {t('rightSidebar.backgroundTasks.noProgress')}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TabBody
// ---------------------------------------------------------------------------

export function BackgroundTasksBody({
  state,
  ctx,
  active,
  shellVisible,
}: {
  state: BackgroundTasksState;
  ctx: TabKindHostContext;
  active?: boolean;
  shellVisible?: boolean;
}) {
  const { t } = useTranslation();
  const sessionId = ctx.sessionId || null;
  // 不可见(非激活 tab / 壳子隐藏)时暂停 store 订阅;active/shellVisible 缺省视为可见。
  const visible = (active ?? true) && (shellVisible ?? true);

  // 快照水合:挂载 / 切会话时拉一次存量后台任务(订阅前已启动 / 重载清空
  // taskUpdates 后事件流看不到的任务)。listSessionBackgroundTasksFor 按会话来源
  // 路由 —— 本机走本地 IPC,device-link 远程隧道到被控端(任务真身在被控端,
  // 本机快照必空);老被控端无此 channel 时内部降级空表。失败静默,实时事件流
  // 自然补上(与 useBackgroundBashTasks 的快照失败同口径)。
  useEffect(() => {
    if (!sessionId) return;
    let disposed = false;
    void listSessionBackgroundTasksFor(sessionId)
      .then(({ tasks }) => {
        if (disposed || !Array.isArray(tasks) || tasks.length === 0) return;
        makerChatStore.seedBackgroundTaskSnapshots(sessionId, tasks);
      })
      .catch(() => {
        // 静默:与 useBackgroundBashTasks 的快照失败同口径。
      });
    return () => {
      disposed = true;
    };
  }, [sessionId]);

  const inputs = useSessionTaskInputs(sessionId, !visible);

  const { running, completed } = useMemo(
    () =>
      listSessionTasks({
        // listSessionTasks 签名按 DB 行(ccAgent.types.Message)声明,其
        // readToolCall 已显式兼容 store 侧 ChatMessage 形态(顶层 toolName /
        // toolInput),此处按契约文档喂 store 消息数组,只做类型断言不改数据。
        messages: inputs.messages as unknown as readonly Message[],
        taskUpdates: inputs.taskUpdates,
        isSessionStreaming: inputs.isStreaming,
      }),
    [inputs],
  );

  // 详情选中:存 item.key(跨状态翻转稳定);条目消失时自动回列表视图。
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selectedItem = useMemo(() => {
    if (!selectedKey) return null;
    return (
      running.find((it) => it.key === selectedKey) ??
      completed.find((it) => it.key === selectedKey) ??
      null
    );
  }, [selectedKey, running, completed]);

  // focusTaskId(tab state)消费:对应 workflow 任务出现后直接进详情并清空请求
  // (数据可能晚于挂载到达,依赖列表变化重试;消费即清,避免跨重启反复弹详情)。
  const focusTaskId = state.focusTaskId ?? null;
  useEffect(() => {
    if (!focusTaskId) return;
    const target =
      running.find((it) => it.kind === 'workflow' && it.taskId === focusTaskId) ??
      completed.find((it) => it.kind === 'workflow' && it.taskId === focusTaskId);
    if (!target) return;
    setSelectedKey(target.key);
    ctx.patchState({ focusTaskId: null });
  }, [focusTaskId, running, completed, ctx]);

  const handleOpenWorkflow = useCallback((key: string) => {
    setSelectedKey(key);
  }, []);
  const handleBack = useCallback(() => {
    setSelectedKey(null);
  }, []);

  if (selectedItem && selectedItem.kind === 'workflow') {
    // key 强制换任务时重挂载:WorkflowDetail 内部持有 fileProgress state,原地复用
    // 会把上一个任务的 wf 文件数据(logs/detail/聚合)残留合进新任务的树。
    return (
      <WorkflowDetail
        key={selectedItem.key}
        item={selectedItem}
        sessionId={sessionId}
        onBack={handleBack}
      />
    );
  }

  if (running.length === 0 && completed.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <ListTodo size={20} className="text-[var(--text-tertiary)]" aria-hidden="true" />
        <div className="text-12 text-[var(--text-tertiary)]">
          {t('rightSidebar.backgroundTasks.empty')}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
      {running.length > 0 && (
        <>
          <SectionHeader label={t('rightSidebar.backgroundTasks.running')} />
          {running.map((item) => (
            <TaskRow
              key={item.key}
              item={item}
              sessionId={sessionId}
              onOpenWorkflow={handleOpenWorkflow}
            />
          ))}
        </>
      )}
      {completed.length > 0 && (
        <>
          <SectionHeader label={t('rightSidebar.backgroundTasks.completed')} />
          {completed.map((item) => (
            <TaskRow
              key={item.key}
              item={item}
              sessionId={sessionId}
              onOpenWorkflow={handleOpenWorkflow}
            />
          ))}
        </>
      )}
    </div>
  );
}
