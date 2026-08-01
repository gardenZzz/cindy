/**
 * CursorAgent lifecycle unit tests with FakeTransport (no real cursor-agent).
 * Covers: session/load resume + history suppress, invalid-resume CAS,
 * abort → immediate idle, tool-idle timeout → session/cancel.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CursorAgent,
  userMessageToPromptBlocks,
  __setCursorImageBytesReaderForTesting,
  __setCursorPromptImageMaxBytesForTesting,
} from './index.js';
import { CURSOR_STREAM_DISCONNECT_REASON } from './streamDisconnect.js';
import { Maker } from '../../maker.js';
import { createConsoleLogger, type Logger } from '../../interfaces/logger.js';
import type { AuthAdapter } from '../../interfaces/auth-adapter.js';
import type { SessionMeta, SessionStorage } from '../../interfaces/session-storage.js';
import type { AgentEvent } from '../../types/events.js';
import type { CloseHandler, LineHandler, StderrHandler, Transport } from '../acp/transport.js';
import { JSONRPC_VERSION, Method } from '../acp/protocol.js';

class FakeTransport implements Transport {
  readonly written: unknown[] = [];
  private readonly lineHandlers = new Set<LineHandler>();
  private readonly stderrHandlers = new Set<StderrHandler>();
  private readonly closeHandlers = new Set<CloseHandler>();
  private closed = false;
  pid = 4242;
  /** 为 true 时 session/set_mode 不自动回应，id 记入 pendingSetModeIds。 */
  hangSessionSetMode = false;
  pendingSetModeIds: Array<number | string> = [];
  /** session/new|load 附带的 ACP configOptions（thinking/fast/effort 等）。 */
  sessionConfigOptions: unknown[] | null = null;
  /** 为 T2 时序测试暂缓 initialize 回包，确保 listener 先挂载。 */
  deferInitializeResponse = false;
  initializeError: string | null = null;
  pendingInitializeIds: Array<number | string> = [];
  /** 为初始配置流水线测试暂缓非 model 的 set_config_option 回包。 */
  deferConfigResponses = false;
  /** 指定 config id 回错误，验证单项失败不阻断其它项。 */
  readonly configResponseErrors = new Set<string>();
  pendingConfigResponses: Array<{
    id: number | string;
    configOptions?: unknown[];
    error?: { code: number; message: string };
  }> = [];

  async writeLine(line: string): Promise<void> {
    this.written.push(JSON.parse(line));
  }

  onLine(handler: LineHandler): () => void {
    this.lineHandlers.add(handler);
    return () => this.lineHandlers.delete(handler);
  }

  onStderr(handler: StderrHandler): () => void {
    this.stderrHandlers.add(handler);
    return () => this.stderrHandlers.delete(handler);
  }

  onClose(handler: CloseHandler): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  getPid(): number | null {
    return this.closed ? null : this.pid;
  }

  async close(reason = 'fake close'): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.pid = 0;
    for (const h of this.closeHandlers) h({ reason });
  }

  emit(value: unknown): void {
    const line = typeof value === 'string' ? value : JSON.stringify(value);
    for (const h of this.lineHandlers) h(line);
  }

  findRequest(method: string): { id: number | string; params?: unknown } | undefined {
    for (const msg of this.written) {
      if (
        isRecord(msg) &&
        msg.method === method &&
        (typeof msg.id === 'number' || typeof msg.id === 'string')
      ) {
        return { id: msg.id as number | string, params: msg.params };
      }
    }
    return undefined;
  }

  findAllRequests(method: string): Array<{ id: number | string; params?: unknown }> {
    const out: Array<{ id: number | string; params?: unknown }> = [];
    for (const msg of this.written) {
      if (
        isRecord(msg) &&
        msg.method === method &&
        (typeof msg.id === 'number' || typeof msg.id === 'string')
      ) {
        out.push({ id: msg.id as number | string, params: msg.params });
      }
    }
    return out;
  }

  findNotifications(method: string): unknown[] {
    return this.written.filter(
      (msg) => isRecord(msg) && msg.method === method && !('id' in msg),
    );
  }

  resolvePendingSetModes(): void {
    for (const id of this.pendingSetModeIds) {
      this.emit({
        jsonrpc: JSONRPC_VERSION,
        id,
        result: {},
      });
    }
    this.pendingSetModeIds = [];
  }

  resolveInitializeResponse(): void {
    const pending = this.pendingInitializeIds.splice(0);
    for (const id of pending) {
      this.emit(
        this.initializeError
          ? {
              jsonrpc: JSONRPC_VERSION,
              id,
              error: { code: -32000, message: this.initializeError },
            }
          : {
              jsonrpc: JSONRPC_VERSION,
              id,
              result: {
                protocolVersion: 1,
                agentCapabilities: {
                  loadSession: true,
                  promptCapabilities: { image: true },
                },
                authMethods: [],
              },
            },
      );
    }
  }

  get deferredConfigResponseCount(): number {
    return this.pendingConfigResponses.length;
  }

  resolveDeferredConfigResponses(reverse = false): void {
    const pending = this.pendingConfigResponses.splice(0);
    if (reverse) pending.reverse();
    for (const response of pending) {
      this.emit({
        jsonrpc: JSONRPC_VERSION,
        id: response.id,
        ...(response.error
          ? { error: response.error }
          : { result: { configOptions: response.configOptions } }),
      });
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function authStub(): AuthAdapter {
  return {
    getState: async () => ({ authenticated: true }),
    triggerLogin: async () => ({ authenticated: true }),
    logout: async () => undefined,
    getAuthEnv: async () => ({}),
  };
}

type RecordedLog = {
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  scope: string;
  msg: string;
  ctx?: Record<string, unknown>;
};

function recordingLogger(records: RecordedLog[], scope = 'maker'): Logger {
  const record = (
    level: RecordedLog['level'],
    msg: string,
    ctx?: Record<string, unknown>,
  ): void => {
    records.push({ level, scope, msg, ctx });
  };
  return {
    trace: (msg, ctx) => record('trace', msg, ctx),
    debug: (msg, ctx) => record('debug', msg, ctx),
    info: (msg, ctx) => record('info', msg, ctx),
    warn: (msg, ctx) => record('warn', msg, ctx),
    error: (msg, ctx) => record('error', msg, ctx),
    fatal: (msg, ctx) => record('fatal', msg, ctx),
    child: (sub) => recordingLogger(records, `${scope}/${sub}`),
  };
}

function createSessionStorage(): {
  storage: SessionStorage;
  updates: Array<{ id: string; patch: Partial<SessionMeta> }>;
} {
  const rows = new Map<string, SessionMeta>();
  const updates: Array<{ id: string; patch: Partial<SessionMeta> }> = [];
  const storage: SessionStorage = {
    async create(meta) {
      const now = Date.now();
      const row = { ...meta, createdAt: now, updatedAt: now };
      rows.set(row.id, row);
      return row;
    },
    async get(id) {
      return rows.get(id) ?? null;
    },
    async list() {
      return [...rows.values()];
    },
    async update(id, patch) {
      const row = rows.get(id);
      if (!row) throw new Error(`missing ${id}`);
      updates.push({ id, patch });
      const next = { ...row, ...patch, updatedAt: Date.now() };
      rows.set(id, next);
      return next;
    },
    async compareAndClearSdkSessionId(id, expectedSdkSessionId) {
      const row = rows.get(id);
      if (!row || row.sdkSessionId !== expectedSdkSessionId) return false;
      rows.set(id, { ...row, sdkSessionId: undefined, updatedAt: Date.now() });
      return true;
    },
    async delete(id) {
      rows.delete(id);
    },
  };
  return { storage, updates };
}

const MODELS = {
  currentModelId: 'default',
  availableModels: [{ modelId: 'default', name: 'Auto' }],
};

async function drainUntil(
  events: AsyncIterable<AgentEvent>,
  pred: (ev: AgentEvent) => boolean,
  timeoutMs = 2000,
): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  const iter = events[Symbol.asyncIterator]();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const next = await Promise.race([
      iter.next(),
      new Promise<{ done: true; value: undefined }>((resolve) =>
        setTimeout(() => resolve({ done: true, value: undefined }), remaining),
      ),
    ]);
    if (next.done) break;
    if (next.value) {
      out.push(next.value);
      if (pred(next.value)) break;
    }
  }
  return out;
}

async function bootWithTransport(
  transport: FakeTransport,
  startOpts: Record<string, unknown> = {},
  models: { currentModelId: string; availableModels: Array<{ modelId: string; name: string }> } = MODELS,
  logger: Logger = createConsoleLogger('cursor-lifecycle-unit'),
  waitUntilReady = true,
): Promise<{
  agent: CursorAgent;
  handle: Awaited<ReturnType<CursorAgent['startSession']>>;
  userDataPath: string;
}> {
  const userDataPath = mkdtempSync(join(tmpdir(), 'cindy-cursor-life-'));
  const agent = new CursorAgent({
    auth: authStub(),
    runtimeConfig: { userDataPath },
    binaryPath: '/dev/null/cursor-agent',
    logger,
    networkConfigReader: () => undefined,
  });

  // Respond to initialize + session create/load as requests arrive.
  const autoReply = transport.onLine(() => {
    /* armed by client.start */
  });
  autoReply();

  // Patch writeLine to auto-respond to initialize / session/* synchronously after push.
  const origWrite = transport.writeLine.bind(transport);
  transport.writeLine = async (line: string) => {
    await origWrite(line);
    const msg = JSON.parse(line) as Record<string, unknown>;
    if (typeof msg.id !== 'number' && typeof msg.id !== 'string') return;
    if (msg.method === Method.Initialize) {
      if (transport.deferInitializeResponse) {
        transport.pendingInitializeIds.push(msg.id as number | string);
      } else {
        queueMicrotask(() =>
          transport.emit({
            jsonrpc: JSONRPC_VERSION,
            id: msg.id,
            result: {
              protocolVersion: 1,
              agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
              authMethods: [],
            },
          }),
        );
      }
      return;
    }
    if (msg.method === Method.SessionNew) {
      queueMicrotask(() =>
        transport.emit({
          jsonrpc: JSONRPC_VERSION,
          id: msg.id,
          result: {
            sessionId: 'fresh-session-id',
            models,
            ...(transport.sessionConfigOptions
              ? { configOptions: transport.sessionConfigOptions }
              : {}),
          },
        }),
      );
      return;
    }
    if (msg.method === Method.SessionLoad) {
      const params = msg.params as { sessionId?: string };
      const sid = params?.sessionId ?? '';
      queueMicrotask(() => {
        // History replay BEFORE result — must be suppressed by CursorAgent.
        transport.emit({
          jsonrpc: JSONRPC_VERSION,
          method: Method.SessionUpdate,
          params: {
            sessionId: sid,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'REPLAYED_HISTORY' },
            },
          },
        });
        if (sid === 'dead-session') {
          transport.emit({
            jsonrpc: JSONRPC_VERSION,
            id: msg.id,
            error: {
              code: -32602,
              message: 'Invalid params',
              data: { message: `Session "${sid}" not found` },
            },
          });
          return;
        }
        transport.emit({
          jsonrpc: JSONRPC_VERSION,
          id: msg.id,
          result: {
            models,
            ...(transport.sessionConfigOptions
              ? { configOptions: transport.sessionConfigOptions }
              : {}),
          },
        });
      });
      return;
    }
    if (msg.method === Method.SessionSetConfigOption) {
      const params = msg.params as { configId?: string; value?: string } | undefined;
      const configId = params?.configId ?? '';
      const shouldDefer = transport.deferConfigResponses && configId !== 'model';
      if (transport.configResponseErrors.has(configId)) {
        const error = { code: -32001, message: `Fake ${configId} failure` };
        if (shouldDefer) {
          transport.pendingConfigResponses.push({ id: msg.id as number | string, error });
        } else {
          queueMicrotask(() =>
            transport.emit({
              jsonrpc: JSONRPC_VERSION,
              id: msg.id,
              error,
            }),
          );
        }
        return;
      }
      let configOptions = transport.sessionConfigOptions ?? [];
      // 真实 ACP 回包会把 set 过的 option 的 currentValue 更新成刚设的值。
      // 用独立快照构造每个回包，流水线测试可模拟乱序到达时的旧全量快照。
      if (
        Array.isArray(transport.sessionConfigOptions) &&
        transport.sessionConfigOptions.length > 0
      ) {
        const cid = configId;
        configOptions = transport.sessionConfigOptions.map((raw) => {
          if (!isRecord(raw) || raw.id !== cid) return raw;
          return { ...raw, currentValue: params?.value ?? 'true' };
        });
      }
      if (!shouldDefer) {
        transport.sessionConfigOptions = configOptions;
      }
      if (shouldDefer) {
        transport.pendingConfigResponses.push({
          id: msg.id as number | string,
          configOptions,
        });
        return;
      }
      queueMicrotask(() =>
        transport.emit({
          jsonrpc: JSONRPC_VERSION,
          id: msg.id,
          result: { configOptions },
        }),
      );
      return;
    }
    if (msg.method === Method.SessionSetMode) {
      if (transport.hangSessionSetMode) {
        transport.pendingSetModeIds.push(msg.id as number | string);
        return;
      }
      queueMicrotask(() =>
        transport.emit({
          jsonrpc: JSONRPC_VERSION,
          id: msg.id,
          result: {},
        }),
      );
      return;
    }
    if (msg.method === Method.SessionPrompt) {
      // Hang by default — tests complete/cancel explicitly.
      return;
    }
  };

  try {
    const { vendorOptions: startVendorOptions, ...restStartOpts } = startOpts;
    const handle = await agent.startSession({
      sessionId: 'biz-1',
      model: 'auto',
      workingDir: '/tmp',
      ...restStartOpts,
      vendorOptions: {
        createAcpTransport: () => transport,
        ...(isRecord(startVendorOptions) ? startVendorOptions : {}),
      },
    });
    if (waitUntilReady) await waitForBootstrapReady(handle);
    return { agent, handle, userDataPath };
  } catch (err) {
    rmSync(userDataPath, { recursive: true, force: true });
    throw err;
  }
}

async function waitForBootstrapReady(handle: Awaited<ReturnType<CursorAgent['startSession']>>): Promise<void> {
  const ready = handle.bootstrapReady;
  if (!ready) throw new Error('Cursor test handle is missing bootstrap readiness seam');
  await ready;
}

async function withBootedSession(
  run: (ctx: {
    transport: FakeTransport;
    handle: Awaited<ReturnType<CursorAgent['startSession']>>;
    agent: CursorAgent;
  }) => Promise<void>,
  startOpts: Record<string, unknown> = {},
  models?: { currentModelId: string; availableModels: Array<{ modelId: string; name: string }> },
): Promise<void> {
  const transport = new FakeTransport();
  const { agent, handle, userDataPath } = await bootWithTransport(transport, startOpts, models);
  try {
    await waitForBootstrapReady(handle);
    await run({ transport, handle, agent });
  } finally {
    await handle.close().catch(() => undefined);
    await agent.dispose().catch(() => undefined);
    rmSync(userDataPath, { recursive: true, force: true });
  }
}

describe('CursorAgent lifecycle (FakeTransport)', () => {
  /**
   * 退出应用走 Maker.shutdown → agent.dispose()，此时会话通常还活着。其余用例
   * 一律先 handle.close() 再 dispose，dispose 排空 liveSessionClosers 这条路
   * 从没被压过——而 #9「退出应用后无残留 cursor-agent 进程」正是它。
   */
  it('dispose() closes still-live sessions (app-quit path)', async () => {
    const transport = new FakeTransport();
    const { agent, userDataPath } = await bootWithTransport(transport);
    try {
      expect(transport.getPid(), 'transport should be live before dispose').toBe(4242);
      // 故意不调 handle.close()：模拟用户直接退出应用。
      await agent.dispose();
      expect(transport.getPid(), 'transport still live after dispose').toBeNull();
    } finally {
      rmSync(userDataPath, { recursive: true, force: true });
    }
  });

  it('logs startup timing segments for new and resumed sessions', async () => {
    const businessSessionId = '12345678-1234-1234-1234-123456789abc';
    const cases = [
      {
        startOpts: {},
        resume: 'new',
        sessionMethod: 'session/new',
      },
      {
        startOpts: { resumeSessionId: 'resume-me-please' },
        resume: 'resume-me-please',
        sessionMethod: 'session/load',
      },
    ] as const;

    for (const testCase of cases) {
      const transport = new FakeTransport();
      const records: RecordedLog[] = [];
      const { agent, handle, userDataPath } = await bootWithTransport(
        transport,
        { sessionId: businessSessionId, ...testCase.startOpts },
        MODELS,
        recordingLogger(records),
      );
      try {
        const ready = records.find(
          (entry) => entry.level === 'info' && entry.msg === 'session ready',
        );
        expect(ready).toBeDefined();
        expect(ready?.scope).toBe(`maker/s:${businessSessionId}/cursor-agent`);
        expect(ready?.ctx).toMatchObject({
          model: 'auto',
          effort: 'default',
          workDir: '/tmp',
          resume: testCase.resume,
          sessionMethod: testCase.sessionMethod,
          resumed: testCase.sessionMethod === 'session/load',
        });
        for (const field of ['spawnInitializeMs', 'sessionMs', 'initialConfigMs']) {
          expect(ready?.ctx?.[field]).toEqual(expect.any(Number));
          expect(ready?.ctx?.[field]).toBeGreaterThanOrEqual(0);
        }
      } finally {
        await handle.close().catch(() => undefined);
        await agent.dispose().catch(() => undefined);
        rmSync(userDataPath, { recursive: true, force: true });
      }
    }
  });

  it('writes Maker metadata when handle returns early and model fallback arrives later', async () => {
    const cases = [
      {
        id: 'cursor-maker-new',
        resumeSessionId: undefined,
        expectedSdkSessionId: 'fresh-session-id',
        method: Method.SessionNew,
      },
      {
        id: 'cursor-maker-load',
        resumeSessionId: 'resume-maker-session',
        expectedSdkSessionId: 'resume-maker-session',
        method: Method.SessionLoad,
      },
    ] as const;

    for (const testCase of cases) {
      const transport = new FakeTransport();
      // Hold initialize until Maker has mounted its listener. The fallback error
      // is then produced after handle return, which is the T2 regression shape.
      transport.deferInitializeResponse = true;
      transport.configResponseErrors.add('model');
      const { storage, updates } = createSessionStorage();
      if (testCase.resumeSessionId) {
        await storage.create({
          id: testCase.id,
          agentKind: 'cursor',
          workDir: '/tmp',
          title: 'Cursor resume',
          model: 'claude-opus-5',
          sdkSessionId: testCase.resumeSessionId,
        });
      }

      const { agent, handle, userDataPath } = await bootWithTransport(
        transport,
        {
          model: 'claude-opus-5',
          ...(testCase.resumeSessionId ? { resumeSessionId: testCase.resumeSessionId } : {}),
        },
        MODELS,
        createConsoleLogger('cursor-lifecycle-early-return'),
        false,
      );
      expect(handle.id).toBe('<pending>');
      // 同一个 id 同时出现在启动期重放与 live 流，验证 Maker 去重而不是重复写库。
      (handle.startupEvents as AgentEvent[]).push({
        type: 'session_id',
        data: testCase.expectedSdkSessionId,
        source: 'cursor',
      });
      vi.spyOn(agent, 'startSession').mockResolvedValue(handle);
      const maker = new Maker({
        agents: { cursor: agent },
        storage,
        logger: createConsoleLogger('cursor-maker'),
      });

      try {
        await maker.createSession({
          id: testCase.id,
          agentKind: 'cursor',
          workingDir: '/tmp',
          model: 'claude-opus-5',
          ...(testCase.resumeSessionId ? { resumeSessionId: testCase.resumeSessionId } : {}),
          vendorOptions: { createAcpTransport: () => transport },
        });
        transport.resolveInitializeResponse();

        await vi.waitFor(async () => {
          const row = await storage.get(testCase.id);
          expect(row?.sdkSessionId).toBe(testCase.expectedSdkSessionId);
          expect(row?.model).toBe('auto');
        });

        expect(transport.findRequest(testCase.method)).toBeTruthy();
        // resume 场景库内已存期望 id, SDK 重推同 id 时 Maker 判等跳过 update (#46),
        // 不再冗余写库顶 updatedAt; 全新会话库内无 id, 仍恰好写一次。
        const expectedSdkWrites = testCase.resumeSessionId ? 0 : 1;
        expect(updates.filter(({ patch }) => patch.sdkSessionId)).toHaveLength(expectedSdkWrites);
        expect(updates.filter(({ patch }) => patch.model)).toHaveLength(1);
      } finally {
        await maker.closeSession(testCase.id).catch(() => undefined);
        await agent.dispose().catch(() => undefined);
        rmSync(userDataPath, { recursive: true, force: true });
      }
    }
  });

  it('closes an in-flight bootstrap before initialize without leaving a transport', async () => {
    const transport = new FakeTransport();
    transport.deferInitializeResponse = true;
    const { agent, handle, userDataPath } = await bootWithTransport(
      transport,
      {},
      MODELS,
      createConsoleLogger('cursor-lifecycle-close-before-ready'),
      false,
    );
    try {
      expect(handle.id).toBe('<pending>');
      await handle.close();
      expect(transport.getPid()).toBeNull();
      expect(transport.findRequest(Method.SessionNew)).toBeUndefined();
      await expect(handle.bootstrapReady).rejects.toThrow(/bootstrap cancelled|closed/);
    } finally {
      await agent.dispose().catch(() => undefined);
      rmSync(userDataPath, { recursive: true, force: true });
    }
  });

  it('accepts and cancels the first turn before bootstrap is ready', async () => {
    const transport = new FakeTransport();
    transport.deferInitializeResponse = true;
    const { agent, handle, userDataPath } = await bootWithTransport(
      transport,
      {},
      MODELS,
      createConsoleLogger('cursor-lifecycle-abort-before-ready'),
      false,
    );
    try {
      await expect(handle.send({ type: 'user', content: 'queued before ready' })).resolves.toBeUndefined();
      await handle.abort();
      expect(transport.getPid()).toBeNull();
      expect(transport.findRequest(Method.SessionNew)).toBeUndefined();
      expect(transport.findRequest(Method.SessionPrompt)).toBeUndefined();
    } finally {
      await handle.close().catch(() => undefined);
      await agent.dispose().catch(() => undefined);
      rmSync(userDataPath, { recursive: true, force: true });
    }
  });

  it('applies the last pre-ready model, effort, fast, and plan selections after bootstrap', async () => {
    const transport = new FakeTransport();
    transport.deferInitializeResponse = true;
    transport.sessionConfigOptions = pipelineOptions();
    const { agent, handle, userDataPath } = await bootWithTransport(
      transport,
      {},
      pipelineModels(),
      createConsoleLogger('cursor-lifecycle-pre-ready-options'),
      false,
    );
    try {
      await handle.setModel!('claude-opus-5');
      await handle.setModel!('gpt-5.5');
      await handle.setEffort!('low');
      await handle.setEffort!('high');
      await handle.setFastMode!(false);
      await handle.setFastMode!(true);
      await handle.setPermissionMode!('ask');
      await handle.setPermissionMode!('auto');
      await handle.setPlanMode!(false);
      await handle.setPlanMode!(true);

      transport.resolveInitializeResponse();
      await handle.bootstrapReady;

      const configRequests = transport.findAllRequests(Method.SessionSetConfigOption);
      expect(
        configRequests
          .filter((request) => (request.params as { configId?: string }).configId === 'model')
          .at(-1)?.params,
      ).toMatchObject({ value: 'gpt-5.5' });
      expect(
        configRequests
          .filter((request) => (request.params as { configId?: string }).configId === 'effort')
          .at(-1)?.params,
      ).toMatchObject({ value: 'high' });
      expect(
        configRequests
          .filter((request) => (request.params as { configId?: string }).configId === 'fast')
          .at(-1)?.params,
      ).toMatchObject({ value: 'true' });
      expect(handle.model).toBe('gpt-5.5');
      expect(handle.getFastMode?.()).toBe(true);
      expect(
        transport
          .findAllRequests(Method.SessionSetMode)
          .some((request) => (request.params as { modeId?: string }).modeId === 'plan'),
      ).toBe(true);
    } finally {
      await handle.close().catch(() => undefined);
      await agent.dispose().catch(() => undefined);
      rmSync(userDataPath, { recursive: true, force: true });
    }
  });

  it('terminates a queued first turn with the bootstrap error and reuses it on later send', async () => {
    const transport = new FakeTransport();
    transport.deferInitializeResponse = true;
    transport.initializeError = 'cursor-agent is not authenticated; run cursor-agent login';
    const { agent, handle, userDataPath } = await bootWithTransport(
      transport,
      {},
      MODELS,
      createConsoleLogger('cursor-lifecycle-bootstrap-error'),
      false,
    );
    try {
      await expect(handle.send({ type: 'user', content: 'first message' })).resolves.toBeUndefined();
      transport.resolveInitializeResponse();
      await expect(handle.bootstrapReady).rejects.toThrow(/cursor-agent login/);

      const events = await drainUntil(
        handle.events(),
        (event) =>
          event.type === 'error' &&
          (event.data as { isTerminal?: boolean }).isTerminal === true,
      );
      expect(String((events.at(-1)?.data as { message?: string }).message)).toContain(
        'cursor-agent login',
      );
      await expect(handle.send({ type: 'user', content: 'second message' })).rejects.toThrow(/cursor-agent login/);
    } finally {
      await handle.close().catch(() => undefined);
      await agent.dispose().catch(() => undefined);
      rmSync(userDataPath, { recursive: true, force: true });
    }
  });

  it('resume via session/load skips upstream history replay', async () => {
    await withBootedSession(async ({ transport, handle }) => {
      const load = transport.findRequest(Method.SessionLoad);
      expect(load).toBeTruthy();
      expect((load!.params as { sessionId: string }).sessionId).toBe('resume-me-please');
      expect(handle.id).toBe('resume-me-please');

      const early: AgentEvent[] = [];
      const consume = (async () => {
        for await (const ev of handle.events()) {
          early.push(ev);
          if (early.length > 20) break;
        }
      })();

      await new Promise((r) => setTimeout(r, 30));
      await handle.close();
      await consume;

      const textBlobs = early
        .filter((e) => e.type === 'text')
        .map((e) => String((e.data as { text?: string }).text ?? ''));
      expect(textBlobs.join('')).not.toContain('REPLAYED_HISTORY');
      expect(early.find((e) => e.type === 'session_id')?.data).toBe('resume-me-please');
    }, { resumeSessionId: 'resume-me-please' });
  });

  it('invalid resume clears via CAS and creates a fresh session with readable hint', async () => {
    const cas = vi.fn(async () => true);
    await withBootedSession(async ({ transport, handle }) => {
      expect(cas).toHaveBeenCalledWith('dead-session');
      expect(handle.id).toBe('fresh-session-id');
      expect(transport.findRequest(Method.SessionNew)).toBeTruthy();

      const events: AgentEvent[] = [];
      const consume = (async () => {
        for await (const ev of handle.events()) {
          events.push(ev);
          if (ev.type === 'session_id') break;
        }
      })();
      await Promise.race([consume, new Promise((r) => setTimeout(r, 500))]);

      const hint = events.find((e) => e.type === 'error');
      expect(hint).toBeTruthy();
      expect(String((hint!.data as { message?: string }).message)).toContain('无法恢复');
      expect((hint!.data as { isTerminal?: boolean }).isTerminal).toBe(false);
      expect(events.find((e) => e.type === 'session_id')?.data).toBe('fresh-session-id');
    }, {
      resumeSessionId: 'dead-session',
      onInvalidResumeSession: cas,
    });
  });

  it('abort sends session/cancel and immediately returns UI to idle', async () => {
    await withBootedSession(async ({ transport, handle }) => {
      const events: AgentEvent[] = [];
      const consume = (async () => {
        for await (const ev of handle.events()) {
          events.push(ev);
        }
      })();

      const sendPromise = handle.send({ type: 'user', content: 'hello' });
      const deadline = Date.now() + 1000;
      while (Date.now() < deadline && !transport.findRequest(Method.SessionPrompt)) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(transport.findRequest(Method.SessionPrompt)).toBeTruthy();

      await handle.abort();

      const idle = await drainUntil(
        (async function* () {
          for (const ev of events) yield ev;
          for await (const ev of handle.events()) yield ev;
        })(),
        (ev) => ev.type === 'status' && (ev.data as { isRunning?: boolean }).isRunning === false,
        500,
      ).catch(() => events);

      const sawCancelledStatus = events.some(
        (e) =>
          e.type === 'status' &&
          (e.data as { isRunning?: boolean; status?: string }).isRunning === false,
      );
      expect(sawCancelledStatus).toBe(true);
      expect(transport.findNotifications(Method.SessionCancel).length).toBeGreaterThan(0);

      const prompt = transport.findRequest(Method.SessionPrompt)!;
      transport.emit({
        jsonrpc: JSONRPC_VERSION,
        id: prompt.id,
        result: { stopReason: 'cancelled' },
      });
      await sendPromise;
      await handle.close();
      await consume;
      void idle;
    });
  });

  it('tool-call idle watchdog cancels with readable timeout message', async () => {
    vi.stubEnv('CINDY_CURSOR_TOOL_IDLE_MS', '50');
    try {
      await withBootedSession(async ({ transport, handle }) => {
        const events: AgentEvent[] = [];
        const consume = (async () => {
          for await (const ev of handle.events()) {
            events.push(ev);
          }
        })();

        const sendPromise = handle.send({ type: 'user', content: 'use a tool' });
        const deadline = Date.now() + 1000;
        while (Date.now() < deadline && !transport.findRequest(Method.SessionPrompt)) {
          await new Promise((r) => setTimeout(r, 10));
        }

        transport.emit({
          jsonrpc: JSONRPC_VERSION,
          method: Method.SessionUpdate,
          params: {
            sessionId: handle.id,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'hanging-tool',
              title: 'Shell',
              kind: 'execute',
              status: 'in_progress',
            },
          },
        });

        const timeoutDeadline = Date.now() + 2000;
        while (Date.now() < timeoutDeadline) {
          if (
            events.some(
              (e) =>
                e.type === 'error' &&
                String((e.data as { reason?: string }).reason) === 'tool_call_idle_timeout',
            )
          ) {
            break;
          }
          await new Promise((r) => setTimeout(r, 20));
        }

        const errEv = events.find(
          (e) =>
            e.type === 'error' &&
            (e.data as { reason?: string }).reason === 'tool_call_idle_timeout',
        );
        expect(errEv).toBeTruthy();
        expect(String((errEv!.data as { message?: string }).message)).toContain('无活动');
        expect(transport.findNotifications(Method.SessionCancel).length).toBeGreaterThan(0);

        const prompt = transport.findRequest(Method.SessionPrompt)!;
        transport.emit({
          jsonrpc: JSONRPC_VERSION,
          id: prompt.id,
          result: { stopReason: 'cancelled' },
        });
        await sendPromise;
        await handle.close();
        await consume;
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('does not force Auto when ACP current differs and user never chose a model', async () => {
    const opusModels = {
      currentModelId: 'claude-opus-4-8',
      availableModels: [
        { modelId: 'default', name: 'Auto' },
        { modelId: 'claude-opus-4-8', name: 'Opus' },
      ],
    };
    await withBootedSession(
      async ({ transport, handle }) => {
        expect(handle.model).toBe('claude-opus-4-8');
        const setModelCalls = transport.written.filter((msg) => {
          if (!isRecord(msg) || msg.method !== Method.SessionSetConfigOption) return false;
          const params = msg.params as { configId?: string } | undefined;
          return params?.configId === 'model';
        });
        expect(setModelCalls).toEqual([]);
      },
      { model: 'auto' },
      opusModels,
    );
  });

  it('applies Auto when cursorModelExplicit is set', async () => {
    const opusModels = {
      currentModelId: 'claude-opus-4-8',
      availableModels: [
        { modelId: 'default', name: 'Auto' },
        { modelId: 'claude-opus-4-8', name: 'Opus' },
      ],
    };
    await withBootedSession(
      async ({ transport, handle }) => {
        expect(handle.model).toBe('auto');
        const setModel = transport.written.find((msg) => {
          if (!isRecord(msg) || msg.method !== Method.SessionSetConfigOption) return false;
          const params = msg.params as { configId?: string; value?: string } | undefined;
          return params?.configId === 'model' && params.value === 'default';
        });
        expect(setModel).toBeTruthy();
      },
      {
        model: 'auto',
        vendorOptions: { cursorModelExplicit: true },
      },
      opusModels,
    );
  });

  it('encodes local image files as ACP ImageContentBlock on session/prompt', async () => {
    const imageDir = mkdtempSync(join(tmpdir(), 'cindy-cursor-img-'));
    const imagePath = join(imageDir, 'pic.png');
    // Minimal PNG header bytes are enough for base64 round-trip assertion.
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    try {
      await withBootedSession(async ({ transport, handle }) => {
        const sendPromise = handle.send({
          type: 'user',
          content: [
            { type: 'text', text: 'describe this' },
            { type: 'image', path: imagePath, mimeType: 'image/png' },
          ],
        });
        const deadline = Date.now() + 1000;
        while (Date.now() < deadline && !transport.findRequest(Method.SessionPrompt)) {
          await new Promise((r) => setTimeout(r, 10));
        }
        const prompt = transport.findRequest(Method.SessionPrompt);
        expect(prompt).toBeTruthy();
        const params = prompt!.params as {
          prompt: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
        };
        expect(params.prompt).toEqual([
          { type: 'text', text: 'describe this' },
          {
            type: 'image',
            data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64'),
            mimeType: 'image/png',
          },
        ]);
        transport.emit({
          jsonrpc: JSONRPC_VERSION,
          id: prompt!.id,
          result: { stopReason: 'end_turn' },
        });
        await sendPromise;
      });
    } finally {
      rmSync(imageDir, { recursive: true, force: true });
    }
  });

  it('abort during hanging session/set_mode(plan) never sends session/prompt', async () => {
    await withBootedSession(async ({ transport, handle }) => {
      transport.hangSessionSetMode = true;

      const sendPromise = handle.send(
        { type: 'user', content: 'plan this turn' },
        { planMode: true },
      );

      const modeDeadline = Date.now() + 1000;
      while (Date.now() < modeDeadline && transport.pendingSetModeIds.length === 0) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(transport.pendingSetModeIds.length).toBeGreaterThan(0);
      expect(transport.findAllRequests(Method.SessionPrompt)).toHaveLength(0);

      await handle.abort();
      // 迟到的 set_mode 响应到达后，旧 token 已 finalize，不得再发 prompt。
      transport.resolvePendingSetModes();
      await expect(sendPromise).rejects.toThrow(/cancelled before acceptance/);

      await new Promise((r) => setTimeout(r, 40));
      expect(transport.findAllRequests(Method.SessionPrompt)).toHaveLength(0);
    });
  });

  it('defers auth/bootstrap failures until after handle return and reuses the readable error', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'cindy-cursor-auth-failure-'));
    const getState = vi.fn(async () => ({
      authenticated: false,
      errorReason: 'no_credentials',
    }));
    const agent = new CursorAgent({
      auth: {
        getState,
        triggerLogin: async () => ({ authenticated: false }),
        logout: async () => undefined,
        getAuthEnv: async () => ({}),
      },
      runtimeConfig: { userDataPath },
      binaryPath: '/dev/null/cursor-agent',
      logger: createConsoleLogger(),
      networkConfigReader: () => undefined,
    });
    const handle = await agent.startSession({
        workingDir: '/tmp',
        model: 'auto',
        vendorOptions: {
          createAcpTransport: () => {
          throw new Error('cursor-agent is not authenticated; run cursor-agent login');
          },
        },
    });
    try {
      expect(handle.id).toBe('<pending>');
      expect(getState).not.toHaveBeenCalled();
      await expect(waitForBootstrapReady(handle)).rejects.toThrow(/cursor-agent login/);
      await expect(handle.send({ type: 'user', content: 'retry' })).rejects.toThrow(/cursor-agent login/);
    } finally {
      await handle.close().catch(() => undefined);
      await agent.dispose().catch(() => undefined);
      rmSync(userDataPath, { recursive: true, force: true });
    }
  });

  it('forces thinking=true when model exposes thinking option', async () => {
    const transport = new FakeTransport();
    transport.sessionConfigOptions = [
      {
        id: 'thinking',
        name: 'Thinking',
        currentValue: 'false',
        options: [
          { value: 'false', name: 'Off' },
          { value: 'true', name: 'On' },
        ],
      },
    ];
    const opusModels = {
      currentModelId: 'claude-opus-5',
      availableModels: [
        { modelId: 'default', name: 'Auto' },
        { modelId: 'claude-opus-5', name: 'Opus 5' },
      ],
    };
    const { agent, handle, userDataPath } = await bootWithTransport(
      transport,
      { model: 'claude-opus-5' },
      opusModels,
    );
    try {
      const thinkingSets = transport.written.filter((msg) => {
        if (!isRecord(msg) || msg.method !== Method.SessionSetConfigOption) return false;
        const params = msg.params as { configId?: string; value?: string } | undefined;
        return params?.configId === 'thinking';
      }) as Array<{ params: { configId: string; value: string } }>;
      expect(thinkingSets.length).toBeGreaterThan(0);
      expect(thinkingSets.every((m) => m.params.value === 'true')).toBe(true);
      const thinkingFalse = transport.written.filter((msg) => {
        if (!isRecord(msg) || msg.method !== Method.SessionSetConfigOption) return false;
        const params = msg.params as { configId?: string; value?: string } | undefined;
        return params?.configId === 'thinking' && params.value === 'false';
      });
      expect(thinkingFalse).toEqual([]);
    } finally {
      await handle.close().catch(() => undefined);
      await agent.dispose().catch(() => undefined);
      rmSync(userDataPath, { recursive: true, force: true });
    }
  });

  it('skips thinking config when model has no thinking option', async () => {
    await withBootedSession(async ({ transport }) => {
      const thinkingSets = transport.written.filter((msg) => {
        if (!isRecord(msg) || msg.method !== Method.SessionSetConfigOption) return false;
        const params = msg.params as { configId?: string } | undefined;
        return params?.configId === 'thinking';
      });
      expect(thinkingSets).toEqual([]);
    });
  });

  // ── fast 下发（#22）──────────────────────────────────────────────────
  // 模型暴露 fast option 时，初始 fastMode 与切模型后的补发都要落到 ACP。

  /** FakeTransport 的 SessionSetConfigOption auto-reply 不回写 fast 的
   *  currentValue（只回写 thinking，见 transport 260-282 行），所以回包里
   *  fast 恒为预设的 currentValue，模拟「ACP 侧值 ≠ 会话态」以触发补发。 */
  function fastOption(currentValue = 'false') {
    return {
      id: 'fast',
      name: 'Fast',
      currentValue,
      options: [
        { value: 'false', name: 'Off' },
        { value: 'true', name: 'On' },
      ],
    };
  }

  /** 取出所有 set_config_option('fast', ...) 的下发值，按发出顺序。 */
  function fastSets(transport: FakeTransport): string[] {
    return transport.written
      .filter((msg) => {
        if (!isRecord(msg) || msg.method !== Method.SessionSetConfigOption) return false;
        const params = msg.params as { configId?: string; value?: string } | undefined;
        return params?.configId === 'fast';
      })
      .map((msg) => (msg as { params: { value: string } }).params.value);
  }

  function effortOption(currentValue = 'medium') {
    return {
      id: 'effort',
      name: 'Effort',
      currentValue,
      options: [
        { value: 'medium', name: 'Medium' },
        { value: 'high', name: 'High' },
      ],
    };
  }

  function thinkingOption(currentValue = 'false') {
    return {
      id: 'thinking',
      name: 'Thinking',
      currentValue,
      options: [
        { value: 'false', name: 'Off' },
        { value: 'true', name: 'On' },
      ],
    };
  }

  async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    if (!predicate()) throw new Error(`condition not met within ${timeoutMs}ms`);
  }

  function pipelineModels() {
    return {
      currentModelId: 'default',
      availableModels: [
        { modelId: 'default', name: 'Auto' },
        { modelId: 'claude-opus-5', name: 'Opus 5' },
      ],
    };
  }

  function pipelineOptions(): unknown[] {
    return [effortOption(), fastOption('true'), thinkingOption()];
  }

  it('pipelines initial effort/fast/thinking after model and merges reversed responses', async () => {
    const transport = new FakeTransport();
    transport.sessionConfigOptions = pipelineOptions();
    transport.deferConfigResponses = true;
    const records: RecordedLog[] = [];
    const bootPromise = bootWithTransport(
      transport,
      { model: 'claude-opus-5', effort: 'high', fastMode: false },
      pipelineModels(),
      recordingLogger(records),
    );

    let booted: Awaited<typeof bootPromise> | undefined;
    try {
      await waitUntil(
        () => transport.findAllRequests(Method.SessionSetConfigOption).length === 4,
      );
      const configRequests = transport.findAllRequests(Method.SessionSetConfigOption);
      expect(
        configRequests.map((request) => (request.params as { configId: string }).configId),
      ).toEqual(['model', 'effort', 'fast', 'thinking']);
      expect(transport.deferredConfigResponseCount).toBe(3);

      // All three option requests are already in flight; only now release stale
      // full snapshots in reverse arrival order.
      transport.resolveDeferredConfigResponses(true);
      const ready = await bootPromise;
      booted = ready;

      expect(ready.handle.getFastMode!()).toBe(false);
      transport.deferConfigResponses = false;
      await ready.handle.setEffort!('medium');
      const effortLog = records.find((entry) => entry.msg === 'setEffort');
      expect(effortLog?.ctx).toMatchObject({ from: 'high' });
    } finally {
      transport.resolveDeferredConfigResponses();
      if (!booted) booted = await bootPromise.catch(() => undefined);
      if (booted) {
        await booted.handle.close().catch(() => undefined);
        await booted.agent.dispose().catch(() => undefined);
        rmSync(booted.userDataPath, { recursive: true, force: true });
      }
    }
  });

  it('keeps other initial options effective when one pipeline request fails', async () => {
    const transport = new FakeTransport();
    transport.sessionConfigOptions = pipelineOptions();
    transport.deferConfigResponses = true;
    transport.configResponseErrors.add('effort');
    const records: RecordedLog[] = [];
    const bootPromise = bootWithTransport(
      transport,
      { model: 'claude-opus-5', effort: 'high', fastMode: false },
      pipelineModels(),
      recordingLogger(records),
    );

    let booted: Awaited<typeof bootPromise> | undefined;
    try {
      await waitUntil(
        () => transport.findAllRequests(Method.SessionSetConfigOption).length === 4,
      );
      transport.resolveDeferredConfigResponses(true);
      const ready = await bootPromise;
      booted = ready;

      expect(ready.handle.getFastMode!()).toBe(false);
      expect(
        transport.findAllRequests(Method.SessionSetConfigOption).some(
          (request) => (request.params as { configId: string }).configId === 'thinking',
        ),
      ).toBe(true);
      const warning = records.find((entry) => entry.msg === 'cursor initial setEffort failed');
      expect(warning?.ctx).toMatchObject({
        effort: 'high',
        message: 'acp session/set_config_option error -32001: Fake effort failure',
      });
    } finally {
      transport.resolveDeferredConfigResponses();
      if (!booted) booted = await bootPromise.catch(() => undefined);
      if (booted) {
        await booted.handle.close().catch(() => undefined);
        await booted.agent.dispose().catch(() => undefined);
        rmSync(booted.userDataPath, { recursive: true, force: true });
      }
    }
  });

  // 用户日志实锤：模型设不上 → startSession 抛 → 该 session 每次重建都在同一处
  // 死掉（Orca lead 尤其致命，worker 汇报永远投不进来）。codex / claude 起会话都
  // 不因模型失败而失败，cursor 必须对齐。
  it('starts the session anyway when the initial model cannot be set', async () => {
    const transport = new FakeTransport();
    transport.sessionConfigOptions = pipelineOptions();
    transport.configResponseErrors.add('model');
    const records: RecordedLog[] = [];
    const booted = await bootWithTransport(
      transport,
      { model: 'claude-opus-5', effort: 'high', fastMode: false },
      pipelineModels(),
      recordingLogger(records),
    );

    try {
      expect(booted.handle.id).toBe('fresh-session-id');
      expect(booted.handle.model).toBe('auto');
      const warning = records.find((entry) => entry.msg === 'cursor initial setModel failed');
      expect(warning?.ctx).toMatchObject({ model: 'claude-opus-5' });

      const fallbackEvents = await drainUntil(booted.handle.events(), (event) => event.type === 'error' && (event.data as { reason?: string }).reason === 'initial_model_unavailable');
      expect(fallbackEvents).toHaveLength(1);
      expect(fallbackEvents[0]).toMatchObject({
        type: 'error',
        data: {
          isTerminal: false,
          reason: 'initial_model_unavailable',
        },
        source: 'cursor',
      });
      expect(String((fallbackEvents[0]?.data as { message?: string }).message)).toContain('claude-opus-5');
    } finally {
      await booted.handle.close().catch(() => undefined);
      await booted.agent.dispose().catch(() => undefined);
      rmSync(booted.userDataPath, { recursive: true, force: true });
    }
  });

  it('pipelines initial config on the session/load resume path', async () => {
    const transport = new FakeTransport();
    transport.sessionConfigOptions = pipelineOptions();
    transport.deferConfigResponses = true;
    const bootPromise = bootWithTransport(
      transport,
      {
        model: 'claude-opus-5',
        effort: 'high',
        fastMode: false,
        resumeSessionId: 'resume-pipeline',
      },
      pipelineModels(),
    );

    let booted: Awaited<typeof bootPromise> | undefined;
    try {
      await waitUntil(
        () => transport.findAllRequests(Method.SessionSetConfigOption).length === 4,
      );
      expect(transport.findRequest(Method.SessionLoad)).toBeTruthy();
      expect(transport.deferredConfigResponseCount).toBe(3);
      transport.resolveDeferredConfigResponses(true);
      const ready = await bootPromise;
      booted = ready;
      expect(ready.handle.id).toBe('resume-pipeline');
      expect(ready.handle.getFastMode!()).toBe(false);
    } finally {
      transport.resolveDeferredConfigResponses();
      if (!booted) booted = await bootPromise.catch(() => undefined);
      if (booted) {
        await booted.handle.close().catch(() => undefined);
        await booted.agent.dispose().catch(() => undefined);
        rmSync(booted.userDataPath, { recursive: true, force: true });
      }
    }
  });

  it('issues set_config_option(fast,true) when createSession fastMode=true and model exposes fast', async () => {
    const transport = new FakeTransport();
    transport.sessionConfigOptions = [fastOption('false')];
    const models = {
      currentModelId: 'claude-opus-5',
      availableModels: [
        { modelId: 'default', name: 'Auto' },
        { modelId: 'claude-opus-5', name: 'Opus 5' },
      ],
    };
    const { agent, handle, userDataPath } = await bootWithTransport(
      transport,
      { fastMode: true, model: 'claude-opus-5' },
      models,
    );
    try {
      // 初始下发：fastMode=true -> 'true'。Auto/default 不暴露 fast 会被跳过，
      // 但显式 model=claude-opus-5 走非 followAcpCurrent 路径，set model 后回的
      // configOptions 含 fast，初始下发应命中。
      const sets = fastSets(transport);
      expect(sets.length).toBeGreaterThan(0);
      expect(sets[0]).toBe('true');
    } finally {
      await handle.close().catch(() => undefined);
      await agent.dispose().catch(() => undefined);
      rmSync(userDataPath, { recursive: true, force: true });
    }
  });

  it('reissues fast after setModel to a model that exposes fast option', async () => {
    const transport = new FakeTransport();
    transport.sessionConfigOptions = [fastOption('false')];
    const models = {
      currentModelId: 'claude-opus-5',
      availableModels: [
        { modelId: 'default', name: 'Auto' },
        { modelId: 'claude-opus-5', name: 'Opus 5' },
        { modelId: 'claude-opus-4-8', name: 'Opus 4.8' },
      ],
    };
    const { agent, handle, userDataPath } = await bootWithTransport(
      transport,
      { fastMode: true, model: 'claude-opus-5' },
      models,
    );
    try {
      const beforeSetModel = fastSets(transport).length;
      // 会话当前 fast=true（初始下发过，FakeTransport 已把 fast currentValue 回写成 'true'）。
      // 模拟 per-model 重置：切到 claude-opus-4-8 时，ACP 回包里该模型的 fast 记录值=false。
      // setModel 内部 set_config_option('model',...) 后 FakeTransport 回 sessionConfigOptions，
      // 故把 fast currentValue 重置回 'false' 模拟目标模型的记录值。
      const setFastCurrent = (value: string) => {
        transport.sessionConfigOptions = (transport.sessionConfigOptions ?? []).map((raw) => (isRecord(raw) && raw.id === 'fast' ? { ...raw, currentValue: value } : raw));
      };
      setFastCurrent('false');
      await handle.setModel!('claude-opus-4-8');
      const after = fastSets(transport);
      // setModel 之后应至少补发一次 fast；补发值与切模型前会话态一致 = 'true'。
      const reissued = after.slice(beforeSetModel);
      expect(reissued.length).toBeGreaterThan(0);
      expect(reissued.every((v) => v === 'true')).toBe(true);
    } finally {
      await handle.close().catch(() => undefined);
      await agent.dispose().catch(() => undefined);
      rmSync(userDataPath, { recursive: true, force: true });
    }
  });

  it('does not issue or throw fast when target model has no fast option on setModel', async () => {
    // session/new 不带 fast option（模拟隔离 config dir 下的 default/Auto）。
    const transport = new FakeTransport();
    const models = {
      currentModelId: 'default',
      availableModels: [{ modelId: 'default', name: 'Auto' }],
    };
    const { agent, handle, userDataPath } = await bootWithTransport(
      transport,
      { fastMode: true },
      models,
    );
    try {
      const before = fastSets(transport).length;
      // setModel 到自己（default）仍无 fast option -> 不补发也不抛。
      await expect(handle.setModel!('default')).resolves.toBeUndefined();
      expect(fastSets(transport).length).toBe(before);
    } finally {
      await handle.close().catch(() => undefined);
      await agent.dispose().catch(() => undefined);
      rmSync(userDataPath, { recursive: true, force: true });
    }
  });

  describe('stream disconnect integration (Seam 3)', () => {
    it('attaches CURSOR_STREAM_DISCONNECT_REASON on prompt stream disconnect error response', async () => {
      await withBootedSession(async ({ transport, handle }) => {
        const events: AgentEvent[] = [];
        const consume = (async () => {
          for await (const ev of handle.events()) {
            events.push(ev);
          }
        })();

        const sendPromise = handle.send({ type: 'user', content: 'hello' });
        const deadline = Date.now() + 1000;
        while (Date.now() < deadline && !transport.findRequest(Method.SessionPrompt)) {
          await new Promise((r) => setTimeout(r, 10));
        }
        const prompt = transport.findRequest(Method.SessionPrompt)!;
        expect(prompt).toBeTruthy();

        // Emit stream disconnect JSON-RPC error
        transport.emit({
          jsonrpc: JSONRPC_VERSION,
          id: prompt.id,
          error: {
            code: -32000,
            message:
              'RetriableError: [canceled] http/2 stream closed with error code CANCEL (0x8)',
          },
        });

        await sendPromise.catch(() => undefined);
        await handle.close();
        await consume;

        const errorEvents = events.filter((e) => e.type === 'error');
        expect(errorEvents.length).toBeGreaterThan(0);
        expect(errorEvents[0]?.data).toMatchObject({
          reason: CURSOR_STREAM_DISCONNECT_REASON,
          isTerminal: true,
        });
      });
    });

    it('does not attach CURSOR_STREAM_DISCONNECT_REASON on transport close', async () => {
      await withBootedSession(async ({ transport, handle }) => {
        const events: AgentEvent[] = [];
        const consume = (async () => {
          for await (const ev of handle.events()) {
            events.push(ev);
          }
        })();

        // Trigger transport close (e.g. process exit)
        await transport.close('acp closed');

        await handle.close();
        await consume;

        const errorEvents = events.filter((e) => e.type === 'error');
        expect(errorEvents.length).toBeGreaterThan(0);
        expect(
          (errorEvents[0]?.data as { reason?: string } | undefined)?.reason,
        ).toBeUndefined();
      });
    });
  });
});

describe('userMessageToPromptBlocks (async image path)', () => {
  afterEach(() => {
    __setCursorImageBytesReaderForTesting(null);
    __setCursorPromptImageMaxBytesForTesting(null);
  });

  it('does not sync-block the event loop while a slow image reader is pending', async () => {
    const imageDir = mkdtempSync(join(tmpdir(), 'cindy-cursor-slow-img-'));
    const imagePath = join(imageDir, 'pic.png');
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    writeFileSync(imagePath, png);
    try {
      let readerStarted = false;
      let readerFinished = false;
      __setCursorImageBytesReaderForTesting(async () => {
        readerStarted = true;
        await new Promise((r) => setTimeout(r, 80));
        readerFinished = true;
        return png;
      });

      let ticks = 0;
      const timer = setInterval(() => {
        ticks += 1;
      }, 10);

      const blocksPromise = userMessageToPromptBlocks({
        type: 'user',
        content: [{ type: 'image', path: imagePath, mimeType: 'image/png' }],
      });

      // sync readFileSync 会卡住整个 turn，timers 在返回前不会涨。
      await new Promise((r) => setTimeout(r, 40));
      expect(readerStarted).toBe(true);
      expect(readerFinished).toBe(false);
      expect(ticks).toBeGreaterThan(0);

      const blocks = await blocksPromise;
      clearInterval(timer);
      expect(readerFinished).toBe(true);
      expect(blocks).toEqual([
        { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
      ]);
    } finally {
      rmSync(imageDir, { recursive: true, force: true });
    }
  });

  it('rejects images that exceed the prompt byte limit before base64', async () => {
    const imageDir = mkdtempSync(join(tmpdir(), 'cindy-cursor-big-img-'));
    const imagePath = join(imageDir, 'big.png');
    writeFileSync(imagePath, Buffer.alloc(64, 1));
    try {
      __setCursorPromptImageMaxBytesForTesting(16);
      await expect(
        userMessageToPromptBlocks({
          type: 'user',
          content: [{ type: 'image', path: imagePath, mimeType: 'image/png' }],
        }),
      ).rejects.toThrow(/image exceeds 16 bytes/);
    } finally {
      rmSync(imageDir, { recursive: true, force: true });
    }
  });

  it('keeps original mimeType when resizer skips conversion (under skipUnderBytes)', async () => {
    const imageDir = mkdtempSync(join(tmpdir(), 'cindy-cursor-skip-img-'));
    const imagePath = join(imageDir, 'small.png');
    // 8-byte PNG header ≪ 500KB skip 阈值 → resizer 原样返回原路径。
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    writeFileSync(imagePath, png);
    try {
      const blocks = await userMessageToPromptBlocks({
        type: 'user',
        content: [{ type: 'image', path: imagePath, mimeType: 'image/png' }],
      });
      expect(blocks).toEqual([
        { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
      ]);
    } finally {
      rmSync(imageDir, { recursive: true, force: true });
    }
  });

  it('uses image/webp mimeType and WebP bytes after resizer converts a large PNG', async () => {
    // 修复前：resizer 写出 .webp 但仍沿用 block.mimeType=image/png → 本断言会失败。
    const imageDir = mkdtempSync(join(tmpdir(), 'cindy-cursor-resize-img-'));
    const imagePath = join(imageDir, 'large.png');
    try {
      const sharp = (await import('sharp')).default;
      // 噪声图 + 低压缩，确保 > skipUnderBytes(500KB)，真实触发 WebP 转换。
      const width = 900;
      const height = 900;
      const raw = Buffer.alloc(width * height * 3);
      for (let i = 0; i < raw.length; i++) raw[i] = (i * 37) & 0xff;
      const pngBuf = await sharp(raw, { raw: { width, height, channels: 3 } })
        .png({ compressionLevel: 0 })
        .toBuffer();
      expect(pngBuf.byteLength).toBeGreaterThan(500_000);
      writeFileSync(imagePath, pngBuf);

      const blocks = await userMessageToPromptBlocks({
        type: 'user',
        content: [{ type: 'image', path: imagePath, mimeType: 'image/png' }],
      });

      expect(blocks).toHaveLength(1);
      const imageBlock = blocks[0] as {
        type: string;
        data?: string;
        mimeType?: string;
      };
      expect(imageBlock.type).toBe('image');
      expect(imageBlock.mimeType).toBe('image/webp');
      expect(imageBlock.data).toBeTruthy();
      const decoded = Buffer.from(imageBlock.data!, 'base64');
      expect(decoded.subarray(0, 4).toString('ascii')).toBe('RIFF');
      expect(decoded.subarray(8, 12).toString('ascii')).toBe('WEBP');
      // 不得仍是原 PNG 字节。
      expect(decoded.subarray(0, 8).equals(pngBuf.subarray(0, 8))).toBe(false);
    } finally {
      rmSync(imageDir, { recursive: true, force: true });
    }
  });
});
