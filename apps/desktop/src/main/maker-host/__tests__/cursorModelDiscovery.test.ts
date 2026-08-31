import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-model-cache-test-'));

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/never-used-here' } }));
vi.mock('../logger-adapter.js', () => ({
  desktopMakerLogger: { info: () => {}, warn: () => {}, error: () => {} },
}));
vi.mock('../../appSessionState.js', () => ({
  ownerScopedUserDataPath: (name: string) => path.join(tmpDir, name),
}));

const {
  mapCursorAcpModelsToDescriptors,
  readCachedCursorModels,
  writeCachedCursorModels,
  startCursorModelRefresh,
  cancelCursorModelRefresh,
  isCursorModelRefreshRunning,
  discoverCursorModelOptionsInBackground,
} = await import('../cursor-model-discovery.js');

describe('mapCursorAcpModelsToDescriptors', () => {
  it('maps listing to ModelDescriptor[]', () => {
    const out = mapCursorAcpModelsToDescriptors({
      currentModelId: 'auto',
      models: [
        {
          id: 'auto',
          displayName: 'Auto',
          contextWindow: 200_000,
          efforts: [],
          defaultEffort: null,
        },
        {
          id: 'gpt-5.5',
          displayName: 'GPT-5.5',
          contextWindow: 300_000,
          efforts: ['low', 'high'],
          defaultEffort: 'high',
          supportsFastMode: true,
        },
      ],
    });
    expect(out).toEqual([
      {
        id: 'auto',
        displayName: 'Auto',
        contextWindow: 200_000,
        efforts: [],
        defaultEffort: null,
      },
      {
        id: 'gpt-5.5',
        displayName: 'GPT-5.5',
        contextWindow: 300_000,
        efforts: ['low', 'high'],
        defaultEffort: 'high',
        supportsFastMode: true,
      },
    ]);
  });

  it('按显示名字母升序重排，不沿用上游数组序', () => {
    const model = (id: string, displayName: string) => ({
      id,
      displayName,
      contextWindow: 200_000,
      efforts: [],
      defaultEffort: null,
    });
    const out = mapCursorAcpModelsToDescriptors({
      currentModelId: 'auto',
      models: [
        model('auto', 'Auto'),
        model('cursor-grok-4.6', 'Cursor Grok 4.6'),
        model('claude-opus-5', 'Claude Opus 5'),
        model('gpt-5.6-sol', 'GPT-5.6 Sol'),
        model('gemini-3.7-flash', 'Gemini 3.7 Flash'),
      ],
    });
    expect(out.map((m) => m.displayName)).toEqual([
      'Auto',
      'Claude Opus 5',
      'Cursor Grok 4.6',
      'Gemini 3.7 Flash',
      'GPT-5.6 Sol',
    ]);
  });

  it('版本号按数值比较，且同名条目按 id 兜底定序', () => {
    const model = (id: string, displayName: string) => ({
      id,
      displayName,
      contextWindow: 200_000,
      efforts: [],
      defaultEffort: null,
    });
    const out = mapCursorAcpModelsToDescriptors({
      currentModelId: 'auto',
      models: [
        model('opus-10', 'Claude Opus 10'),
        model('twin-b', 'Claude Opus 5'),
        model('opus-9', 'Claude Opus 9'),
        model('twin-a', 'Claude Opus 5'),
      ],
    });
    expect(out.map((m) => m.id)).toEqual(['twin-a', 'twin-b', 'opus-9', 'opus-10']);
  });
});

describe('模型目录磁盘缓存', () => {
  const cacheFile = path.join(tmpDir, 'cursor-models-cache.json');

  it('没有缓存文件时回 []（调用方保留 Auto 兜底）', () => {
    expect(readCachedCursorModels()).toEqual([]);
  });

  it('写入后可原样读回：冷启动无需先发起会话即可展示', () => {
    const models = [
      { id: 'auto', displayName: 'Auto', contextWindow: 200_000, efforts: [], defaultEffort: null },
      {
        id: 'gpt-5.5',
        displayName: 'GPT-5.5',
        contextWindow: 300_000,
        efforts: ['low', 'high'] as const,
        defaultEffort: 'high' as const,
        supportsFastMode: true,
      },
    ];
    writeCachedCursorModels(models);
    expect(readCachedCursorModels()).toEqual(models);
  });

  it('空清单不覆盖已有缓存', () => {
    const before = fs.readFileSync(cacheFile, 'utf8');
    writeCachedCursorModels([]);
    expect(fs.readFileSync(cacheFile, 'utf8')).toBe(before);
  });

  it('损坏 / 脏条目被收窄掉，不进 capabilities', () => {
    fs.writeFileSync(
      cacheFile,
      JSON.stringify([
        { id: '' },
        'not-an-object',
        { id: 'ok', efforts: ['high', 'bogus'], defaultEffort: 'nope', contextWindow: -1 },
        { id: 'ok', displayName: '重复 id' },
      ]),
      'utf8',
    );
    expect(readCachedCursorModels()).toEqual([
      {
        id: 'ok',
        displayName: 'ok',
        contextWindow: 200_000,
        efforts: ['high'],
        defaultEffort: null,
      },
    ]);
  });

  it('非 JSON 文件回 []', () => {
    fs.writeFileSync(cacheFile, '{ broken', 'utf8');
    expect(readCachedCursorModels()).toEqual([]);
  });
});

describe('探测编排 startCursorModelRefresh (spec #21 / #28)', () => {
  it('进行中互斥:第二轮 start 返回 null,不排队', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const agent = {
      discoverModelOptions: vi.fn(async () => {
        await gate;
      }),
    };
    const first = startCursorModelRefresh(agent);
    expect(first).not.toBeNull();
    expect(isCursorModelRefreshRunning()).toBe(true);
    expect(startCursorModelRefresh(agent)).toBeNull();
    release();
    await vi.waitFor(() => expect(isCursorModelRefreshRunning()).toBe(false));
    expect(agent.discoverModelOptions).toHaveBeenCalledTimes(1);
  });

  it('手动可重入:一轮结束后再 start 真的重跑', async () => {
    const agent = {
      discoverModelOptions: vi.fn(async () => undefined),
    };
    const firstDone = new Promise<void>((resolve) => {
      startCursorModelRefresh(agent, { onDone: () => resolve() });
    });
    await firstDone;
    const secondDone = new Promise<void>((resolve) => {
      const handle = startCursorModelRefresh(agent, { onDone: () => resolve() });
      expect(handle).not.toBeNull();
    });
    await secondDone;
    expect(agent.discoverModelOptions).toHaveBeenCalledTimes(2);
  });

  it('取消后已探结果保留语义:abort 信号传给 agent,onDone aborted=true', async () => {
    let seenSignal: AbortSignal | undefined;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const agent = {
      discoverModelOptions: vi.fn(async (opts: { signal?: AbortSignal }) => {
        seenSignal = opts.signal;
        await gate;
      }),
    };
    const done = new Promise<{ aborted: boolean; error: string | null }>((resolve) => {
      startCursorModelRefresh(agent, { onDone: resolve });
    });
    expect(cancelCursorModelRefresh()).toBe(true);
    expect(seenSignal?.aborted).toBe(true);
    release();
    const result = await done;
    expect(result.aborted).toBe(true);
    expect(isCursorModelRefreshRunning()).toBe(false);
  });

  it('进度回调按 done/total 转发', async () => {
    const progress: Array<{ done: number; total: number }> = [];
    const agent = {
      discoverModelOptions: vi.fn(
        async (opts: { onProgress?: (done: number, total: number) => void }) => {
          opts.onProgress?.(1, 3);
          opts.onProgress?.(2, 3);
          opts.onProgress?.(3, 3);
        },
      ),
    };
    await new Promise<void>((resolve) => {
      startCursorModelRefresh(agent, {
        onProgress: (done, total) => progress.push({ done, total }),
        onDone: () => resolve(),
      });
    });
    expect(progress).toEqual([
      { done: 1, total: 3 },
      { done: 2, total: 3 },
      { done: 3, total: 3 },
    ]);
  });

  it('后台探测复用同一编排,进行中时 no-op', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const agent = {
      discoverModelOptions: vi.fn(async () => {
        await gate;
      }),
    };
    const handle = startCursorModelRefresh(agent);
    expect(handle).not.toBeNull();
    await discoverCursorModelOptionsInBackground(agent);
    // 进行中时后台入口直接返回,不二次调用。
    expect(agent.discoverModelOptions).toHaveBeenCalledTimes(1);
    release();
    await vi.waitFor(() => expect(isCursorModelRefreshRunning()).toBe(false));
  });
});

describe('冷启动不再自动探测 (spec #21 / #29)', () => {
  it('maker-host 装配不再在冷启动无档位时触发 discoverCursorModelOptionsInBackground', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf8');
    // 旧门:if (!cached.some((m) => m.efforts.length > 0)) void discover...
    expect(src).not.toMatch(
      /cached\.some\(\(m\)\s*=>\s*m\.efforts\.length\s*>\s*0\)[\s\S]{0,80}discoverCursorModelOptionsInBackground/,
    );
    // 冷启动只 seed 缓存,不再 import 后台探测到装配路径。
    expect(src).not.toContain('discoverCursorModelOptionsInBackground');
  });
});
