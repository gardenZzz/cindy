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
