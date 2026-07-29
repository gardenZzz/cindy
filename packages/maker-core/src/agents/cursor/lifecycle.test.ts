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
import { createConsoleLogger } from '../../interfaces/logger.js';
import type { AuthAdapter } from '../../interfaces/auth-adapter.js';
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
    logger: createConsoleLogger('cursor-lifecycle-unit'),
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
      return;
    }
    if (msg.method === Method.SessionNew) {
      queueMicrotask(() =>
        transport.emit({
          jsonrpc: JSONRPC_VERSION,
          id: msg.id,
          result: { sessionId: 'fresh-session-id', models },
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
          result: { models },
        });
      });
      return;
    }
    if (msg.method === Method.SessionSetConfigOption) {
      queueMicrotask(() =>
        transport.emit({
          jsonrpc: JSONRPC_VERSION,
          id: msg.id,
          result: { configOptions: [] },
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
    return { agent, handle, userDataPath };
  } catch (err) {
    rmSync(userDataPath, { recursive: true, force: true });
    throw err;
  }
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
          (e.data as { isRunning?: boolean; text?: string }).isRunning === false,
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

  it('startSession throws AgentNotAuthenticatedError when auth is missing', async () => {
    const { AgentNotAuthenticatedError } = await import('../base-agent.js');
    const agent = new CursorAgent({
      auth: {
        getState: async () => ({ authenticated: false, errorReason: 'no_credentials' }),
        triggerLogin: async () => ({ authenticated: false }),
        logout: async () => undefined,
        getAuthEnv: async () => ({}),
      },
      runtimeConfig: {},
      binaryPath: '/dev/null/cursor-agent',
      logger: createConsoleLogger(),
    });
    await expect(
      agent.startSession({
        workingDir: '/tmp',
        model: 'auto',
        vendorOptions: {
          createAcpTransport: () => {
            throw new Error('should not spawn when unauthenticated');
          },
        },
      }),
    ).rejects.toBeInstanceOf(AgentNotAuthenticatedError);
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
      const imageBlock = blocks[0] as { type: string; data?: string; mimeType?: string };
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
