/**
 * CursorAgent.discoverModelOptions —— 全量档位探测（FakeTransport，不起真进程）。
 *
 * 守的是「选择器里每个模型都要有推理强度」：ACP 只在切到某模型后才回它的
 * effort / reasoning，所以必须逐个探；探不动的模型不能拖垮整轮。
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CursorAgent } from './index.js';
import { createConsoleLogger } from '../../interfaces/logger.js';
import type { AuthAdapter } from '../../interfaces/auth-adapter.js';
import type { CursorModelsListing } from './models.js';
import type { CloseHandler, LineHandler, StderrHandler, Transport } from '../acp/transport.js';
import { JSONRPC_VERSION, Method } from '../acp/protocol.js';

const AVAILABLE = [
  { modelId: 'default', name: 'Auto' },
  { modelId: 'claude-opus-5', name: 'Opus 5' },
  { modelId: 'gpt-5.5', name: 'GPT-5.5' },
  { modelId: 'kimi-k2.7-code', name: 'Kimi K2.7 Code' },
];

/** 每个模型自报的 configOptions（形状取自实测 cursor-agent 2026.07）。 */
const OPTIONS_BY_MODEL: Record<string, unknown[]> = {
  'claude-opus-5': [
    {
      id: 'context',
      name: 'Context',
      currentValue: '300k',
      options: [{ value: '300k', name: '300K' }, { value: '1m', name: '1M' }],
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
        { value: 'max', name: 'Max' },
      ],
    },
    {
      id: 'fast',
      name: 'Fast',
      currentValue: 'false',
      options: [{ value: 'false', name: 'Off' }, { value: 'true', name: 'Fast' }],
    },
    {
      id: 'thinking',
      name: 'Thinking',
      currentValue: 'true',
      options: [{ value: 'false', name: 'Off' }, { value: 'true', name: 'On' }],
    },
  ],
  'gpt-5.5': [
    {
      id: 'reasoning',
      name: 'Reasoning',
      currentValue: 'medium',
      options: [
        { value: 'none', name: 'None' },
        { value: 'low', name: 'Low' },
        { value: 'medium', name: 'Medium' },
        { value: 'high', name: 'High' },
        { value: 'extra-high', name: 'Extra High' },
      ],
    },
  ],
};

/** 只回 initialize / session/new / session/set_config_option 的极简 transport。 */
class DiscoveryTransport implements Transport {
  readonly probedModels: string[] = [];
  private readonly lineHandlers = new Set<LineHandler>();
  private readonly closeHandlers = new Set<CloseHandler>();
  /** 这些模型的 set_config_option 回错误，验证单点失败不影响整轮。 */
  constructor(private readonly failingModels: ReadonlySet<string> = new Set()) {}

  async writeLine(line: string): Promise<void> {
    const msg = JSON.parse(line) as Record<string, any>;
    if (typeof msg.id !== 'number' && typeof msg.id !== 'string') return;
    if (msg.method === Method.Initialize) {
      this.reply(msg.id, { protocolVersion: 1, agentCapabilities: {}, authMethods: [] });
      return;
    }
    if (msg.method === Method.SessionNew) {
      this.reply(msg.id, {
        sessionId: 's-discovery',
        models: { currentModelId: 'default', availableModels: AVAILABLE },
      });
      return;
    }
    if (msg.method === Method.SessionSetConfigOption) {
      const value = String(msg.params?.value ?? '');
      this.probedModels.push(value);
      if (this.failingModels.has(value)) {
        this.replyError(msg.id, 'Invalid model value');
        return;
      }
      this.reply(msg.id, {
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            currentValue: value,
            options: AVAILABLE.map((m) => ({ value: m.modelId, name: m.name })),
          },
          ...(OPTIONS_BY_MODEL[value] ?? []),
        ],
      });
      return;
    }
    this.reply(msg.id, {});
  }

  private reply(id: number | string, result: unknown): void {
    queueMicrotask(() => this.emit({ jsonrpc: JSONRPC_VERSION, id, result }));
  }

  private replyError(id: number | string, message: string): void {
    queueMicrotask(() =>
      this.emit({ jsonrpc: JSONRPC_VERSION, id, error: { code: -32602, message } }),
    );
  }

  private emit(value: unknown): void {
    const line = JSON.stringify(value);
    for (const h of this.lineHandlers) h(line);
  }

  onLine(handler: LineHandler): () => void {
    this.lineHandlers.add(handler);
    return () => this.lineHandlers.delete(handler);
  }

  onStderr(_handler: StderrHandler): () => void {
    return () => undefined;
  }

  onClose(handler: CloseHandler): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  getPid(): number | null {
    return 1234;
  }

  async close(reason = 'fake close'): Promise<void> {
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

async function runDiscovery(transport: DiscoveryTransport): Promise<CursorModelsListing[]> {
  const published: CursorModelsListing[] = [];
  const userDataPath = mkdtempSync(join(tmpdir(), 'cindy-cursor-discovery-'));
  const agent = new CursorAgent({
    auth: authStub(),
    runtimeConfig: { userDataPath },
    binaryPath: '/dev/null/cursor-agent',
    logger: createConsoleLogger('cursor-discovery-unit'),
    onCursorLocalModelsListed: (listing) => {
      published.push(listing);
    },
  });
  await agent.discoverModelOptions({
    workingDir: userDataPath,
    userDataPath,
    createTransport: () => transport,
  });
  return published;
}

describe('CursorAgent.discoverModelOptions', () => {
  it('probes every listed model and publishes per-model efforts', async () => {
    const transport = new DiscoveryTransport();
    const published = await runDiscovery(transport);

    expect(transport.probedModels).toEqual([
      'default',
      'claude-opus-5',
      'gpt-5.5',
      'kimi-k2.7-code',
    ]);

    const listing = published.at(-1);
    expect(listing?.currentModelId).toBe('auto');
    const byId = new Map(listing!.models.map((m) => [m.id, m]));
    expect(byId.get('claude-opus-5')).toMatchObject({
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'high',
      contextWindow: 300_000,
      supportsFastMode: true,
      supportsThinkingMode: true,
    });
    // GPT 家族挂在 reasoning 上，none / extra-high 归一到 minimal / xhigh。
    expect(byId.get('gpt-5.5')).toMatchObject({
      efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],
      defaultEffort: 'medium',
    });
    // 无参数模型保持空档位（选择器不显示推理强度）。
    expect(byId.get('kimi-k2.7-code')?.efforts).toEqual([]);
    expect(byId.get('auto')?.efforts).toEqual([]);
  });

  it('keeps going when one model probe fails', async () => {
    const transport = new DiscoveryTransport(new Set(['claude-opus-5']));
    const published = await runDiscovery(transport);

    expect(transport.probedModels).toContain('gpt-5.5');
    const byId = new Map(published.at(-1)!.models.map((m) => [m.id, m]));
    expect(byId.get('claude-opus-5')?.efforts).toEqual([]);
    expect(byId.get('gpt-5.5')?.efforts).toEqual([
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
    ]);
  });
});
