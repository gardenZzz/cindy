/**
 * Cursor ACP tool-call 不活动监督。
 *
 * 上游已知 tool call 偶发无限挂起（zed-industries/zed#56734）。
 * 语义与 Claude upstream-idle **相反**：只在有进行中的 tool call 时计时，
 * 任意 session/update / permission 活动都重置；超时后由调用方 session/cancel。
 *
 * 默认 300s；单测 / 运维可用 `CINDY_CURSOR_TOOL_IDLE_MS` 覆盖。
 */

export const DEFAULT_CURSOR_TOOL_IDLE_MS = 300_000;

export function resolveCursorToolIdleMs(
  env: NodeJS.ProcessEnv = process.env,
  fallback = DEFAULT_CURSOR_TOOL_IDLE_MS,
): number {
  const raw = env.CINDY_CURSOR_TOOL_IDLE_MS;
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

export interface ToolIdleWatchdog {
  /** 记录有进行中的 toolCallId（pending / in_progress）。 */
  noteToolActive(toolCallId: string): void;
  /** tool 终态（completed / failed）或整体清场。 */
  noteToolTerminal(toolCallId: string): void;
  /** 任意活动（文本块、tool update、permission）重置计时。 */
  noteActivity(): void;
  /** 清全部 + 停表（turn 结束 / abort / close）。 */
  clear(): void;
  /** 当前进行中的 tool 数（单测用）。 */
  pendingCount(): number;
}

export function createToolIdleWatchdog(opts: {
  idleMs: number;
  onTimeout: (info: { idleMs: number; pendingToolIds: string[] }) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}): ToolIdleWatchdog {
  const pending = new Set<string>();
  let timer: unknown = null;
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer =
    opts.clearTimer ?? ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>));
  let tripped = false;

  const stopTimer = () => {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  };

  const armTimer = () => {
    stopTimer();
    if (tripped || pending.size === 0 || opts.idleMs <= 0) return;
    const id = setTimer(() => {
      timer = null;
      if (tripped || pending.size === 0) return;
      tripped = true;
      const ids = Array.from(pending);
      opts.onTimeout({ idleMs: opts.idleMs, pendingToolIds: ids });
    }, opts.idleMs);
    timer = id;
    if (typeof id === 'object' && id && 'unref' in id) {
      (id as { unref: () => void }).unref();
    }
  };

  return {
    noteToolActive(toolCallId: string) {
      if (!toolCallId || tripped) return;
      pending.add(toolCallId);
      armTimer();
    },
    noteToolTerminal(toolCallId: string) {
      if (!toolCallId) return;
      pending.delete(toolCallId);
      if (pending.size === 0) {
        stopTimer();
        return;
      }
      armTimer();
    },
    noteActivity() {
      if (tripped || pending.size === 0) return;
      armTimer();
    },
    clear() {
      pending.clear();
      stopTimer();
      tripped = false;
    },
    pendingCount() {
      return pending.size;
    },
  };
}

export function formatCursorToolIdleMessage(idleMs: number): string {
  const secs = Math.max(1, Math.round(idleMs / 1000));
  return (
    `工具调用已超过 ${secs}s 无活动，已自动取消当前轮次` +
    `（上游偶发挂起）。可以直接发下一条消息继续。`
  );
}

export function formatCursorInvalidResumeMessage(sessionId: string): string {
  return (
    `Cursor 会话无法恢复（上游会话已失效：${sessionId.slice(0, 8)}…），` +
    `已新建会话继续。历史仍由 Cindy 本地保存。`
  );
}

export function formatCursorInvalidResumeCasConflictMessage(): string {
  return 'Cursor 会话无法恢复，且会话 ID 已被并发更新，未自动覆盖。请重试。';
}
