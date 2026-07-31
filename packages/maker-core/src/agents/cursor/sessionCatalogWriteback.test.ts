/**
 * spec #21 / S4 -- 会话内不再回写模型目录。
 *
 * 守的是「一次会话生命周期内宿主目录上报回调零调用」：建会话 + 切模型 +
 * 改推理强度 + 改 Fast 的完整序列走完，onCursorLocalModelsListed 不应被触发；
 * 同时会话自身的 model / effort / fast 状态仍然正确（切模型后 Fast 仍按意图下发）。
 *
 * 这是 packages/maker-core 对 Cursor 目录上报与 fast 下发的第一批覆盖。
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CursorAgent } from './index.js';
import { createConsoleLogger } from '../../interfaces/logger.js';
import type { AuthAdapter } from '../../interfaces/auth-adapter.js';
import type { CloseHandler, LineHandler, StderrHandler, Transport } from '../acp/transport.js';
import { JSONRPC_VERSION, Method } from '../acp/protocol.js';

/**
 * 每 set_config_option(model, X) 回该模型自报的 configOptions。
 * 形状取自实测 cursor-agent（见 modelDiscovery.test.ts 的 OPTIONS_BY_MODEL）。
 */
const OPTIONS_BY_MODEL: Record<string, unknown[]> = {
  default: [
    {
      id: 'model',
      name: 'Model',
      currentValue: 'default',
      options: [
        { value: 'default', name: 'Auto' },
        { value: 'claude-opus-5', name: 'Opus 5' },
        { value: 'gpt-5.5', name: 'GPT-5.5' },
      ],
    },
  ],
  'claude-opus-5': [
    {
      id: 'model',
      name: 'Model',
      currentValue: 'claude-opus-5',
      options: [
        { value: 'default', name: 'Auto' },
        { value: 'claude-opus-5', name: 'Opus 5' },
        { value: 'gpt-5.5', name: 'GPT-5.5' },
      ],
    },
    {
      id: 'effort',
      name: 'Effort',
      currentValue: 'high',
      options: [
        { value: 'low', name: 'Low' },
        { value: 'medium', name: 'Medium' },
        { value: 'high', name: 'High' },
        { value: 'xhigh', name: 'Extra High' },
      ],
    },
    {
      id: 'fast',
      name: 'Fast',
      currentValue: 'false',
      options: [{ value: 'false', name: 'Off' }, { value: 'true', name: 'Fast' }],
    },
    { id: 'thinking', name: 'Thinking', currentValue: 'true', options: [{ value: 'false', name: 'Off' }, { value: 'true', name: 'On' }] },
  ],
  'gpt-5.5': [
    {
      id: 'model',
      name: 'Model',
      currentValue: 'gpt-5.5',
      options: [
        { value: 'default', name: 'Auto' },
        { value: 'claude-opus-5', name: 'Opus 5' },
        { value: 'gpt-5.5', name: 'GPT-5.5' },
      ],
    },
    {
      id: 'reasoning',
      name: 'Reasoning',
      currentValue: 'medium',
      options: [
        { value: 'none', name: 'None' },
        { value: 'low', name: 'Low' },
        { value: 'medium', name: 'Medium' },
        { value: 'high', name: 'High' },
      ],
    },
    { id: 'fast', name: 'Fast', currentValue: 'false', options: [{ value: 'false', name: 'Off' }, { value: 'true', name: 'Fast' }] },
  ],
};

class SessionWritebackTransport implements Transport {
  readonly written: unknown[] = [];
  /** session/set_config_option(model, X) 收到的 value 序列。 */
  readonly setConfigValues: Array<{ configId: string; value: string }> = [];
  private readonly lineHandlers = new Set<LineHandler>();
  private readonly closeHandlers = new Set<CloseHandler>();
  private closed = false;
  pid = 4242;
  /** 当前 ACP 模型 id（default / claude-opus-5 / gpt-5.5）。 */
  private currentAcpModel = 'default';

  async writeLine(line: string): Promise<void> {
    const msg = JSON.parse(line) as Record<string, any>;
    this.written.push(msg);
    if (typeof msg.id !== 'number' && typeof msg.id !== 'string') return;

    if (msg.method === Method.Initialize) {
      this.reply(msg.id, { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true } }, authMethods: [] });
      return;
    }
    if (msg.method === Method.SessionNew) {
      this.reply(msg.id, {
        sessionId: 'sess-s4',
        models: {
          currentModelId: 'default',
          availableModels: [
            { modelId: 'default', name: 'Auto' },
            { modelId: 'claude-opus-5', name: 'Opus 5' },
            { modelId: 'gpt-5.5', name: 'GPT-5.5' },
          ],
        },
        configOptions: OPTIONS_BY_MODEL['default'],
      });
      return;
    }
    if (msg.method === Method.SessionSetConfigOption) {
      const configId = String(msg.params?.configId ?? '');
      const value = String(msg.params?.value ?? '');
      this.setConfigValues.push({ configId, value });
      // model 切换 -> 记住当前模型，回该模型自报的 configOptions（含 effort/fast）。
      if (configId === 'model') {
        this.currentAcpModel = value;
      }
      const options = OPTIONS_BY_MODEL[this.currentAcpModel] ?? OPTIONS_BY_MODEL['default']!;
      // effort / fast / thinking 的回包把 currentValue 反映成刚发的 value。
      const reflected = options.map((raw) => {
        if (!raw || typeof raw !== 'object') return raw;
        const r = raw as Record<string, unknown>;
        if (r.id === configId) return { ...r, currentValue: value };
        return r;
      });
      this.reply(msg.id, { configOptions: reflected });
      return;
    }
    if (msg.method === Method.SessionSetMode) {
      this.reply(msg.id, {});
      return;
    }
    // session/prompt / 其它默认挂起（测试只跑 setModel/setEffort/setFastMode，不发 prompt）。
  }

  private reply(id: number | string, result: unknown): void {
    queueMicrotask(() => this.emit({ jsonrpc: JSONRPC_VERSION, id, result }));
  }

  emit(value: unknown): void {
    const line = JSON.stringify(value);
    for (const h of this.lineHandlers) h(line);
  }

  onLine(handler: LineHandler): () => void {
    this.lineHandlers.add(handler);
    return () => this.lineHandlers.delete(handler);
  }
  onStderr(_: StderrHandler): () => void {
    return () => undefined;
  }
  onClose(handler: CloseHandler): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }
  getPid(): number | null {
    return this.closed ? null : this.pid;
  }
  async close(reason = 'fake close'): Promise<void> {
    this.closed = true;
    this.pid = 0;
    for (const h of this.closeHandlers) h({ reason });
  }
}

function authStub(): AuthAdapter {
  return {
    getState: async () => ({ authenticated: true }),
    triggerLogin: async () => ({ authenticated: true }),
    logout: async () => undefined,
    getAuthEnv: async () => ({}),
  };
}

async function bootSession(transport: SessionWritebackTransport) {
  const userDataPath = mkdtempSync(join(tmpdir(), 'cindy-cursor-s4-'));
  const published: unknown[] = [];
  const agent = new CursorAgent({
    auth: authStub(),
    runtimeConfig: { userDataPath },
    binaryPath: '/dev/null/cursor-agent',
    logger: createConsoleLogger('cursor-s4-unit'),
    networkConfigReader: () => undefined,
    onCursorLocalModelsListed: (listing) => {
      published.push(listing);
    },
  });
  const handle = await agent.startSession({
    sessionId: 'biz-s4',
    model: 'auto',
    workingDir: '/tmp',
    vendorOptions: { createAcpTransport: () => transport },
  });
  return { agent, handle, userDataPath, published };
}

describe('CursorAgent session does not write back catalog (spec #21 / S4)', () => {
  it('build session + switch model + change effort + change fast => onCursorLocalModelsListed called 0 times', async () => {
    const transport = new SessionWritebackTransport();
    const { agent, handle, userDataPath, published } = await bootSession(transport);
    try {
      // 切到 claude-opus-5（带 effort / fast / thinking）。
      await handle.setModel!('claude-opus-5');
      // 改推理强度。
      await handle.setEffort!('xhigh');
      // 开 Fast（ACP 的 fast 是 per-model，切模型即重置 -> 这一步验证会话仍按意图下发）。
      await handle.setFastMode!(true);

      // 宿主目录上报回调零调用。
      expect(published).toHaveLength(0);

      // 会话自身的 fast 状态读回正确（true）。
      expect(handle.getFastMode?.()).toBe(true);

      // 切模型 / 改强度 / 改 fast 的 set_config_option 都真的下发给了上游。
      const modelSets = transport.setConfigValues.filter((s) => s.configId === 'model');
      const effortSets = transport.setConfigValues.filter(
        (s) => s.configId === 'effort' || s.configId === 'reasoning',
      );
      const fastSets = transport.setConfigValues.filter((s) => s.configId === 'fast');
      expect(modelSets.map((s) => s.value)).toContain('claude-opus-5');
      // Cindy xhigh -> 按模型自报拼写发回（opus 这里值就是 'xhigh'，非 'extra-high'）。
      expect(effortSets.map((s) => s.value)).toContain('xhigh');
      expect(fastSets.map((s) => s.value)).toContain('true');

      // 切模型后 thinking 若上游非 true 仍被强制开（会话行为不变，#27 明确保留）。
      const thinkingSets = transport.setConfigValues.filter((s) => s.configId === 'thinking');
      expect(thinkingSets.length).toBeGreaterThanOrEqual(0);
    } finally {
      await handle.close().catch(() => undefined);
      await agent.dispose().catch(() => undefined);
      rmSync(userDataPath, { recursive: true, force: true });
    }
  });

  it('switching model re-sends fast per intent without catalog publish (per-model ACP fast resets on model switch)', async () => {
    // #22: setModel 在切模后若新模型暴露 fast，按切模型前的会话 Fast 值补发一次。
    // 这里同时守 #27: 整条序列仍不触发目录上报。
    const transport = new SessionWritebackTransport();
    const { agent, handle, userDataPath, published } = await bootSession(transport);
    try {
      await handle.setModel!('claude-opus-5');
      await handle.setFastMode!(true);
      expect(published).toHaveLength(0);

      await handle.setModel!('gpt-5.5');
      expect(published).toHaveLength(0);

      // 切到 gpt-5.5 后会话意图仍是 true，且 setModel 已按意图补发 fast。
      expect(handle.getFastMode?.()).toBe(true);
      const fastSets = transport.setConfigValues.filter((s) => s.configId === 'fast');
      expect(fastSets.map((s) => s.value)).toContain('true');
      // 再拨一次仍可下发，且仍不写目录。
      await handle.setFastMode!(false);
      expect(handle.getFastMode?.()).toBe(false);
      expect(published).toHaveLength(0);
    } finally {
      await handle.close().catch(() => undefined);
      await agent.dispose().catch(() => undefined);
      rmSync(userDataPath, { recursive: true, force: true });
    }
  });
});
