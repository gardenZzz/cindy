/**
 * SessionRegistry — manages per-session SDK Query lifecycle inside the manager.
 *
 * Phase 2 scope (MVP):
 *   - One Query per session
 *   - Async loop consumes Query → calls onEvent for each SDKMessage
 *   - inputQueue per session — query/send pushes into it, SDK streamInput consumes
 *   - Control methods (setModel/interrupt/etc.) forward to the live Query
 *   - Single attached client per session — newer attach replaces older
 *
 * Phase 5 will add: ring buffer + disk log for detach/reattach replay.
 *
 * SDK Query factory is injected so tests can pass a mock without touching the
 * real @anthropic-ai/claude-agent-sdk. Production binary wires the real SDK.
 */

import type {
  QueryEventNotification,
  SessionClosedNotification,
  SessionListEntry,
  ClientReplacedNotification,
} from './protocol.js';
import { createAsyncQueue, type AsyncQueue } from './async-queue.js';

/* ============================== SDK-shaped types ============================== */

/**
 * Minimal subset of @anthropic-ai/claude-agent-sdk Query interface that the
 * manager actually uses. Declared locally to keep this file SDK-version-agnostic
 * (manager binary pins SDK in package.json; this interface evolves with it).
 */
export interface SdkQueryLike extends AsyncIterable<unknown> {
  interrupt(): Promise<void>;
  setModel(model?: string): Promise<void>;
  setPermissionMode(mode: string): Promise<void>;
  applyFlagSettings(settings: Record<string, unknown>): Promise<void>;
  getContextUsage?(): Promise<unknown>;
  /** Optional — stop a single background task (SDK >= 0.2.x). */
  stopTask?(taskId: string): Promise<void>;
  // streamInput(stream: AsyncIterable<...>) is implicit — we pass our queue
  // via options.prompt at construction time, not via post-construction call.
}

/**
 * canUseTool callback shape — mirrors SDK's CanUseTool but simplified for
 * wire transport. The daemon-side callback forwards this to the attached
 * client via reverse-request RPC.
 */
export type CanUseToolCallback = (
  toolName: string,
  input: Record<string, unknown>,
  options: {
    toolUseID: string;
    title?: string;
    displayName?: string;
    description?: string;
    suggestions?: unknown[];
    blockedPath?: string;
    decisionReason?: string;
    agentID?: string;
  },
) => Promise<{
  behavior: 'allow' | 'deny';
  updatedInput?: Record<string, unknown>;
  updatedPermissions?: unknown[];
  message?: string;
}>;

export interface SdkQueryFactoryOptions {
  /** SDK options.prompt — push-based AsyncIterable of user messages. */
  inputStream: AsyncIterable<unknown>;
  /** Working directory for the cc subprocess. */
  cwd: string;
  /** Model id to start with. */
  model: string;
  /** Env dict forwarded to cc subprocess (auth, base url, etc.). */
  env: Record<string, string>;
  /** MCP server configs (stdio/sse/http only — in-process rejected before this layer). */
  mcpServers?: Record<string, unknown>;
  /** Defaults to acceptEdits in MVP — host explicitly passes if different. */
  permissionMode?: string;
  /** Verbatim passthrough; we don't introspect. */
  systemPrompt?: unknown;
  /** Verbatim passthrough. */
  additionalDirectories?: string[];
  /** Verbatim passthrough. */
  allowedTools?: string[];
  /** Verbatim passthrough. */
  disallowedTools?: string[];
  /** Verbatim passthrough (preset shape). */
  tools?: unknown;
  /** Resume an SDK session by uuid (Phase 5 reattach). */
  resume?: string;
  /** Any extra SDK options to merge in last. */
  extraOptions?: Record<string, unknown>;
  /**
   * canUseTool callback — when SDK needs permission, this is called.
   * If not provided, SDK uses its own permissionMode logic (acceptEdits default).
   */
  canUseTool?: CanUseToolCallback;
}

/**
 * Factory returns an SDK Query-shaped object. Production wires the real SDK;
 * tests wire a fake that emits scripted events.
 */
export type SdkQueryFactory = (opts: SdkQueryFactoryOptions) => SdkQueryLike;

/* ============================== Session state ============================== */

export interface CreateSessionOptions {
  sessionId: string;
  cwd: string;
  model: string;
  env: Record<string, string>;
  mcpServers?: Record<string, unknown>;
  permissionMode?: string;
  systemPrompt?: unknown;
  additionalDirectories?: string[];
  allowedTools?: string[];
  disallowedTools?: string[];
  tools?: unknown;
  resumeSdkSessionId?: string;
  extraOptions?: Record<string, unknown>;
}

/**
 * Per-session ring buffer entry. Mirrors QueryEventNotification fields so
 * replay just sends them out verbatim.
 */
interface BufferedEvent {
  seq: number;
  ts: string;
  message: unknown;
}

interface SessionState {
  sessionId: string;
  cwd: string;
  model: string;
  inputQueue: AsyncQueue<unknown>;
  query: SdkQueryLike;
  /** Seq counter — monotonic per session. */
  nextSeq: number;
  /** Latest seq we've emitted (`nextSeq - 1` after first event). */
  lastSeq: number;
  /** ISO when session was created. */
  startedAt: string;
  /** ISO of last observed SDK event (null until first event). */
  lastEventAt: string | null;
  /** SDK's internal session uuid, captured from first SDKSystemMessage (init). */
  sdkSessionId: string | null;
  /** Whether the consume loop is still running. */
  alive: boolean;
  /**
   * forceful kill 已开始 (interrupt 发出、inputQueue 已/将 end) 但 consume
   * loop 尚未退出 — 此窗口内 alive 仍为 true, sendMessage 必须显式拒绝
   * (Greptile P1: ended queue 的 push 静默丢, 其他连接 attach+send 会让
   * 用户消息看似成功实则消失)。
   */
  killing?: boolean;
  /** Currently attached client's notify function; null when no client is attached. */
  attachedNotify: AttachedNotify | null;
  /**
   * In-memory ring buffer of recent events for detach/reattach replay.
   * When over capacity, oldest entries are dropped (replay can't go back
   * to seq=1 anymore — UI should warn or refresh).
   */
  buffer: BufferedEvent[];
  /** Max events buffered before dropping oldest. */
  bufferCapacity: number;
  /** Lowest seq still present in buffer (so client can know if replay covers their sinceSeq). */
  bufferFirstSeq: number;
}

/**
 * Notify callback installed via `registry.attach()`. Single union signature so
 * TypeScript can dispatch the three variants without complaining about
 * overload mismatches. Callers narrow on `kind` to read `n` safely.
 */
export type AttachedNotify = (
  kind: 'event' | 'closed' | 'replaced',
  n: QueryEventNotification | SessionClosedNotification | ClientReplacedNotification,
) => void;

/* ============================== Registry ============================== */

/**
 * Callback that the session registry invokes when SDK's canUseTool fires for
 * a session. The implementation should forward this as a reverse-request to
 * the attached client and return the client's decision.
 */
export type ApprovalRequestForwarder = (
  sessionId: string,
  params: import('./protocol.js').ApprovalRequestParams,
) => Promise<import('./protocol.js').ApprovalRequestResult>;

export interface SessionRegistryOptions {
  sdkQueryFactory: SdkQueryFactory;
  /**
   * Max events buffered per session for replay on reattach. Default 1000.
   * Phase 5 keeps this in-memory only; later PR adds disk log so reconnect
   * across manager restart works.
   */
  bufferCapacity?: number;
  /**
   * Called when a session's SDK canUseTool fires and a client is attached.
   * Implementation should send a reverse-request RPC to the client. If not
   * provided (or if no client is attached), the registry defaults to 'deny'.
   */
  onApprovalRequest?: ApprovalRequestForwarder;
  logger?: {
    debug(msg: string, ctx?: Record<string, unknown>): void;
    info(msg: string, ctx?: Record<string, unknown>): void;
    warn(msg: string, ctx?: Record<string, unknown>): void;
    error(msg: string, ctx?: Record<string, unknown>): void;
  };
}

const DEFAULT_BUFFER_CAPACITY = 1000;

export class SessionRegistry {
  private readonly sessions = new Map<string, SessionState>();
  private readonly factory: SdkQueryFactory;
  private readonly logger: NonNullable<SessionRegistryOptions['logger']>;
  private readonly bufferCapacity: number;
  private readonly onApprovalRequest?: ApprovalRequestForwarder;

  constructor(opts: SessionRegistryOptions) {
    this.factory = opts.sdkQueryFactory;
    this.bufferCapacity = opts.bufferCapacity ?? DEFAULT_BUFFER_CAPACITY;
    this.onApprovalRequest = opts.onApprovalRequest;
    this.logger =
      opts.logger ?? {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      };
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  create(opts: CreateSessionOptions): SessionState {
    const existing = this.sessions.get(opts.sessionId);
    if (existing?.alive) {
      throw makeRegistryError('SESSION_ALREADY_EXISTS', `session ${opts.sessionId} already exists`);
    }
    if (existing) {
      // existing dead session(same sessionId 复用): 直接 delete 让新 query/start
      // 接管。**MVP**:dead session 未读 events(断开期间产出)当前**不恢复**;SDK 已把
      // 它们写进 jsonl,future 走 read-since-lineNo recovery 从磁盘读回(follow-up,
      // 尚未实现)。删掉这个内存 entry 是安全的,不影响未来的 jsonl recovery。
      this.sessions.delete(opts.sessionId);
    }
    const inputQueue = createAsyncQueue<unknown>();

    // sessionRef is captured by the canUseTool closure (called later, after session is assigned).
    let sessionRef: SessionState | null = null;

    // Build canUseTool callback that routes approval requests to attached client via RPC.
    const canUseTool: CanUseToolCallback | undefined = this.onApprovalRequest
      ? async (toolName, input, options) => {
          if (!sessionRef?.attachedNotify) {
            this.logger.warn('canUseTool fired without attached client — denying', {
              sessionId: opts.sessionId,
              toolName,
            });
            return { behavior: 'deny', message: 'no client attached for approval' };
          }
          try {
            const result = await this.onApprovalRequest!(opts.sessionId, {
              sessionId: opts.sessionId,
              requestId: options.toolUseID,
              kind: toolName === 'AskUserQuestion' ? 'ask_user_question'
                : toolName === 'ExitPlanMode' ? 'plan_review'
                : 'permission',
              toolName,
              input,
              title: options.title,
              displayName: options.displayName,
              description: options.description,
              suggestions: options.suggestions,
              metadata: {
                ...(options.blockedPath ? { blockedPath: options.blockedPath } : {}),
                ...(options.decisionReason ? { decisionReason: options.decisionReason } : {}),
                ...(options.agentID ? { agentID: options.agentID } : {}),
              },
            });
            if (result.kind === 'ask_user_question') {
              return {
                behavior: 'allow',
                updatedInput: { ...input, answers: result.answers ?? {} },
              };
            }
            if (result.kind === 'plan_review') {
              if (result.behavior === 'deny') {
                return { behavior: 'deny', message: result.reason ?? 'plan rejected by user' };
              }
              const finalPlan = result.editedPlan ?? (input as Record<string, unknown>).plan;
              return { behavior: 'allow', updatedInput: { ...input, plan: finalPlan } };
            }
            // permission kind
            if (result.behavior === 'allow') {
              return {
                behavior: 'allow',
                updatedInput: result.updatedInput ?? input,
                updatedPermissions: result.permissionUpdates,
              };
            }
            return { behavior: 'deny', message: result.reason ?? 'denied by user' };
          } catch (err) {
            this.logger.warn('onApprovalRequest threw — denying', {
              sessionId: opts.sessionId,
              toolName,
              error: (err as Error).message,
            });
            return { behavior: 'deny', message: 'approval request failed' };
          }
        }
      : undefined;

    const sdkOpts: SdkQueryFactoryOptions = {
      inputStream: inputQueue,
      cwd: opts.cwd,
      model: opts.model,
      env: opts.env,
      ...(opts.mcpServers ? { mcpServers: opts.mcpServers } : {}),
      ...(opts.permissionMode ? { permissionMode: opts.permissionMode } : { permissionMode: 'acceptEdits' }),
      ...(opts.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
      ...(opts.additionalDirectories ? { additionalDirectories: opts.additionalDirectories } : {}),
      ...(opts.allowedTools ? { allowedTools: opts.allowedTools } : {}),
      ...(opts.disallowedTools ? { disallowedTools: opts.disallowedTools } : {}),
      ...(opts.tools !== undefined ? { tools: opts.tools } : {}),
      ...(opts.resumeSdkSessionId ? { resume: opts.resumeSdkSessionId } : {}),
      ...(opts.extraOptions ? { extraOptions: opts.extraOptions } : {}),
      ...(canUseTool ? { canUseTool } : {}),
    };
    const query = this.factory(sdkOpts);
    const session: SessionState = {
      sessionId: opts.sessionId,
      cwd: opts.cwd,
      model: opts.model,
      inputQueue,
      query,
      nextSeq: 1,
      lastSeq: 0,
      startedAt: new Date().toISOString(),
      lastEventAt: null,
      sdkSessionId: null,
      alive: true,
      attachedNotify: null,
      buffer: [],
      bufferCapacity: this.bufferCapacity,
      bufferFirstSeq: 1,
    };
    sessionRef = session;
    this.sessions.set(opts.sessionId, session);
    this.startConsumeLoop(session);
    this.logger.info('session created', { sessionId: opts.sessionId, model: opts.model });
    return session;
  }

  get(sessionId: string): SessionState {
    const s = this.sessions.get(sessionId);
    if (!s) {
      throw makeRegistryError('SESSION_NOT_FOUND', `session ${sessionId} not found`);
    }
    return s;
  }

  list(): SessionListEntry[] {
    const out: SessionListEntry[] = [];
    for (const s of this.sessions.values()) {
      out.push(this.sessionToListEntry(s));
    }
    return out;
  }

  private sessionToListEntry(s: SessionState): SessionListEntry {
    return {
      sessionId: s.sessionId,
      ...(s.sdkSessionId ? { sdkSessionId: s.sdkSessionId } : {}),
      cwd: s.cwd,
      model: s.model,
      lastSeq: s.lastSeq,
      alive: s.alive,
      startedAt: s.startedAt,
      lastEventAt: s.lastEventAt,
    };
  }

  /**
   * Push a user message into the session's SDK input queue.
   */
  sendMessage(sessionId: string, message: unknown): void {
    const s = this.get(sessionId);
    if (!s.alive) {
      throw makeRegistryError('SESSION_NOT_FOUND', `session ${sessionId} is no longer alive`);
    }
    // kill 窗口 (killing=true 且 consume loop 未退出) 必须显式拒绝:
    // inputQueue 已 end, push 静默丢 — 看似发送成功实则消息消失
    // (Greptile P1)。调用方应稍后重试或走 fresh start。
    if (s.killing) {
      throw makeRegistryError(
        'SESSION_KILL_PENDING',
        `session ${sessionId} is being killed (input closed) — retry shortly or start a fresh query`,
      );
    }
    s.inputQueue.push(message);
  }

  async setModel(sessionId: string, model: string): Promise<void> {
    const s = this.get(sessionId);
    await s.query.setModel(model);
    s.model = model; // Local mirror — actual SDK takes effect next turn.
  }

  async setPermissionMode(sessionId: string, mode: string): Promise<void> {
    const s = this.get(sessionId);
    await s.query.setPermissionMode(mode);
  }

  async applyFlagSettings(sessionId: string, settings: Record<string, unknown>): Promise<void> {
    const s = this.get(sessionId);
    await s.query.applyFlagSettings(settings);
  }

  async getContextUsage(sessionId: string): Promise<unknown> {
    const s = this.get(sessionId);
    if (!s.query.getContextUsage) {
      throw makeRegistryError('SDK_ERROR', 'query.getContextUsage is not supported by this SDK');
    }
    return s.query.getContextUsage();
  }

  async interrupt(sessionId: string): Promise<void> {
    const s = this.get(sessionId);
    await s.query.interrupt();
  }

  /** 停止单个后台任务(desktop 用户 Stop 的确定性全停链路,SDK 老版本不支持时报错由客户端降级)。 */
  async stopTask(sessionId: string, taskId: string): Promise<void> {
    const s = this.get(sessionId);
    if (!s.query.stopTask) {
      throw makeRegistryError('SDK_ERROR', 'query.stopTask is not supported by this SDK');
    }
    await s.query.stopTask(taskId);
  }

  /**
   * Close a session: end input queue (lets SDK exit cleanly), mark dead.
   * Idempotent.
   *
   * **关键**: `s.alive = false` 必须在 inputQueue.end() 之前 (或之后立刻) set,
   * **不能等 SDK consume loop 自然退出再设**。否则:
   * 1. client 调 query/close → 这里 return
   * 2. user 立即调 query/send (或新 client attach + send) → openCcManagerSession
   *    看 list 还是 alive=true → 不走 fresh start, 直接 push 进 inputQueue
   * 3. inputQueue 已 end, AsyncQueue.push 静默丢 (没 throw)
   * 4. UI 卡 streaming, 远端永远没新 turn
   * 早设 alive=false 让后续 attach / start 路径正确判 dead。
   */
  async close(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    if (!s.alive) return;
    s.alive = false;
    try {
      await s.query.interrupt();
    } catch (err) {
      this.logger.warn('query interrupt during close threw', {
        sessionId,
        error: (err as Error).message,
      });
    }
    s.inputQueue.end();
  }

  /**
   * Kill (forceful): end input queue + remove from registry without waiting
   * for consume loop to drain. Loop will exit on its own after this.
   */
  async kill(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    if (!s.alive) {
      this.sessions.delete(sessionId);
      return;
    }
    // 先标 killing 再 interrupt:终止窗口从这一刻起对 sendMessage 可见
    // (Greptile P1, 见 SessionState.killing)。
    s.killing = true;
    try {
      await s.query.interrupt();
    } catch (err) {
      this.logger.warn('query interrupt during kill threw', {
        sessionId,
        error: (err as Error).message,
      });
    }
    s.inputQueue.end();
    // Loop will discover end + remove from registry.
  }

  /**
   * Attach a client's notify callback to receive event notifications.
   * If another client is already attached, replace it (notify old that
   * it has been replaced).
   *
   * Returns the session's current lastSeq so the client can request
   * replay-from-X if it had been receiving events before disconnect.
   *
   * Phase 5 will add: replay events with seq > sinceSeq from disk log.
   * Phase 2 just connects to live stream (sinceSeq is recorded but no replay).
   */
  attach(
    sessionId: string,
    notify: AttachedNotify,
    opts: { sinceSeq?: number } = {},
  ): { currentSeq: number; alive: boolean; replayedCount: number; replayLossy: boolean } {
    const s = this.get(sessionId);
    if (s.attachedNotify && s.attachedNotify !== notify) {
      const replacedNotify = s.attachedNotify;
      // Switch to new client first, then notify the old one (avoid race).
      s.attachedNotify = notify;
      try {
        const replacedMsg: ClientReplacedNotification = {
          sessionId,
          reason: 'another-client-attached',
        };
        replacedNotify('replaced', replacedMsg);
      } catch (err) {
        this.logger.warn('failed to notify replaced client', {
          sessionId,
          error: (err as Error).message,
        });
      }
    } else {
      s.attachedNotify = notify;
    }
    // Replay buffered events with seq > sinceSeq (if requested).
    let replayedCount = 0;
    let replayLossy = false;
    if (opts.sinceSeq !== undefined && s.buffer.length > 0) {
      // If sinceSeq is before bufferFirstSeq, we've dropped events the client needs.
      // We still replay what we have; client sees a gap (signaled by replayLossy).
      if (opts.sinceSeq < s.bufferFirstSeq - 1) {
        replayLossy = true;
      }
      for (const ev of s.buffer) {
        if (ev.seq <= opts.sinceSeq) continue;
        const notification: QueryEventNotification = {
          sessionId,
          seq: ev.seq,
          ts: ev.ts,
          message: ev.message,
        };
        try {
          notify('event', notification);
          replayedCount++;
        } catch (err) {
          this.logger.warn('replay event throw', {
            sessionId,
            seq: ev.seq,
            error: (err as Error).message,
          });
        }
      }
    }
    return { currentSeq: s.lastSeq, alive: s.alive, replayedCount, replayLossy };
  }

  /**
   * Detach a specific client's notify (if it's the current attached one).
   * Used when a client disconnects gracefully.
   */
  detachIfCurrent(sessionId: string, notify: AttachedNotify): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    if (s.attachedNotify === notify) {
      s.attachedNotify = null;
    }
  }

  /**
   * Detach all sessions that are using the given notify (used when a client
   * connection drops — clear it from every session it might have been on).
   */
  detachAll(notify: AttachedNotify): void {
    for (const s of this.sessions.values()) {
      if (s.attachedNotify === notify) {
        s.attachedNotify = null;
      }
    }
  }

  /**
   * Daemon-wide graceful shutdown — broadcast SESSION_CLOSED with reason='killed'
   * to every still-attached client, then mark all sessions as not-alive.
   *
   * Called from the cc-mgr SIGTERM / SIGINT handler **before** server.stop()
   * closes the socket, so each attached desktop client gets an explicit
   * "session ended" notification it can use to:
   *   1. unblock the in-flight turn's for-await loop (RemoteQuery treats
   *      SESSION_CLOSED as iterator-end)
   *   2. surface a structured error to maker / renderer (vs the silent
   *      "ssh stream just stopped" state, which leaves UI stuck in
   *      isStreaming=true forever — see U2 fallback)
   *
   * Without this, force-upgrade pkill'ing the daemon would silently drop
   * every active turn — UI stays in "thinking..." state until user restarts
   * the desktop. With this, U2's translator can convert SESSION_CLOSED into
   * a proper aborted-turn event, U3 can read those aborts to schedule auto-retry.
   */
  shutdownAll(detail?: string): void {
    for (const s of this.sessions.values()) {
      // Mark dead BEFORE notify — keeps `alive` flag consistent if notify
      // synchronously throws (we still want the registry to reflect the
      // post-shutdown state).
      const wasAlive = s.alive;
      s.alive = false;
      if (wasAlive) {
        this.notifyClosed(s, 'killed', detail ?? 'daemon shutting down');
      }
    }
  }

  /* ============================== private ============================== */

  private startConsumeLoop(session: SessionState): void {
    void (async (): Promise<void> => {
      try {
        for await (const message of session.query) {
          this.recordEvent(session, message);
        }
        // Generator returned normally — session completed.
        session.alive = false;
        this.notifyClosed(session, 'completed');
      } catch (err) {
        session.alive = false;
        this.logger.warn('session consume loop threw', {
          sessionId: session.sessionId,
          error: (err as Error).message,
        });
        this.notifyClosed(session, 'error', (err as Error).message);
      }
    })();
  }

  private recordEvent(session: SessionState, message: unknown): void {
    const seq = session.nextSeq++;
    session.lastSeq = seq;
    const ts = new Date().toISOString();
    session.lastEventAt = ts;

    // Capture SDK's session uuid from the first SDKSystemMessage (init subtype).
    if (!session.sdkSessionId && isSdkInitMessage(message)) {
      session.sdkSessionId = message.session_id;
    }

    // Append to ring buffer for replay. Drop oldest when over capacity.
    session.buffer.push({ seq, ts, message });
    if (session.buffer.length > session.bufferCapacity) {
      const dropped = session.buffer.shift();
      if (dropped) {
        session.bufferFirstSeq = dropped.seq + 1;
      }
    }

    const notification: QueryEventNotification = {
      sessionId: session.sessionId,
      seq,
      ts,
      message,
    };
    if (session.attachedNotify) {
      try {
        session.attachedNotify('event', notification);
      } catch (err) {
        this.logger.warn('attachedNotify event threw', {
          sessionId: session.sessionId,
          seq,
          error: (err as Error).message,
        });
      }
    }
  }

  private notifyClosed(session: SessionState, reason: SessionClosedNotification['reason'], detail?: string): void {
    if (session.attachedNotify) {
      try {
        const n: SessionClosedNotification = {
          sessionId: session.sessionId,
          reason,
          ...(detail ? { detail } : {}),
        };
        session.attachedNotify('closed', n);
      } catch (err) {
        this.logger.warn('attachedNotify closed threw', {
          sessionId: session.sessionId,
          error: (err as Error).message,
        });
      }
    }
    // GC: keep dead session briefly for session/list diagnostics, then remove
    // to prevent unbounded memory growth in long-running daemon.
    setTimeout(() => {
      const current = this.sessions.get(session.sessionId);
      if (current === session && !current.alive) {
        this.sessions.delete(session.sessionId);
        session.buffer.length = 0;
      }
    }, 60_000);
  }
}

interface RegistryError extends Error {
  code: 'SESSION_NOT_FOUND' | 'SESSION_ALREADY_EXISTS' | 'SDK_ERROR';
}

function makeRegistryError(code: RegistryError['code'], message: string): RegistryError {
  const err = new Error(message) as RegistryError;
  err.code = code;
  return err;
}

/** SDK's first SDKSystemMessage variant always has subtype='init' and session_id. */
function isSdkInitMessage(msg: unknown): msg is { type: 'system'; subtype: 'init'; session_id: string } {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as Record<string, unknown>;
  return m.type === 'system' && m.subtype === 'init' && typeof m.session_id === 'string';
}
