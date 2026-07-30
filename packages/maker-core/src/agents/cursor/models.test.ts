import { describe, expect, it } from 'vitest';

import {
  CURSOR_ACP_AUTO_MODEL_ID,
  CURSOR_PRODUCT_AUTO_MODEL_ID,
  cursorAutoModelFallback,
  cursorListingToDescriptors,
  enrichCursorModelFromConfigOptions,
  findCursorEffortOption,
  parseAcpConfigOptions,
  parseCursorModelsState,
  toCursorAcpModelId,
  toCursorConfigEffortValue,
  toCursorProductModelId,
  type CursorListedModel,
} from './models.js';

describe('cursor model id mapping', () => {
  it('maps ACP default ↔ product auto', () => {
    expect(toCursorProductModelId(CURSOR_ACP_AUTO_MODEL_ID)).toBe(CURSOR_PRODUCT_AUTO_MODEL_ID);
    expect(toCursorAcpModelId(CURSOR_PRODUCT_AUTO_MODEL_ID)).toBe(CURSOR_ACP_AUTO_MODEL_ID);
    expect(toCursorProductModelId('gpt-5.5')).toBe('gpt-5.5');
    expect(toCursorAcpModelId('gpt-5.5')).toBe('gpt-5.5');
  });
});

describe('parseCursorModelsState', () => {
  it('parses session/new models and remaps Auto', () => {
    const listing = parseCursorModelsState({
      currentModelId: 'default',
      availableModels: [
        { modelId: 'default', name: 'Auto' },
        { modelId: 'gpt-5.5', name: 'GPT-5.5' },
      ],
    });
    expect(listing).toEqual({
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
          contextWindow: 200_000,
          efforts: [],
          defaultEffort: null,
        },
      ],
    });
  });

  it('returns null for empty / malformed payloads', () => {
    expect(parseCursorModelsState(null)).toBeNull();
    expect(parseCursorModelsState({})).toBeNull();
    expect(parseCursorModelsState({ currentModelId: 'default', availableModels: [] })).toBeNull();
  });
});

describe('enrichCursorModelFromConfigOptions', () => {
  it('fills effort / fast / context from set_config_option result', () => {
    const models: CursorListedModel[] = [
      { id: 'auto', displayName: 'Auto', contextWindow: 200_000, efforts: [], defaultEffort: null },
      {
        id: 'claude-opus-4-8',
        displayName: 'Opus 4.8',
        contextWindow: 200_000,
        efforts: [],
        defaultEffort: null,
      },
    ];
    const options = parseAcpConfigOptions([
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
        options: [
          { value: 'false', name: 'Off' },
          { value: 'true', name: 'Fast' },
        ],
      },
      {
        id: 'context',
        name: 'Context',
        currentValue: '300k',
        options: [
          { value: '300k', name: '300K' },
          { value: '1m', name: '1M' },
        ],
      },
    ]);
    enrichCursorModelFromConfigOptions(models, 'claude-opus-4-8', options);
    expect(models[1]).toMatchObject({
      id: 'claude-opus-4-8',
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'high',
      supportsFastMode: true,
      contextWindow: 300_000,
    });
    expect(cursorListingToDescriptors(models)[1]?.supportsFastMode).toBe(true);
  });

  // GPT / Kimi / GLM 家族把推理强度挂在 `reasoning` 上，拼写也和 Claude 家族不同：
  // 只认 `effort` + 只认 xhigh 拼写的话，这半边模型在选择器里没有推理强度可选。
  it('reads GPT-family reasoning option and normalizes extra-high / none', () => {
    const models: CursorListedModel[] = [
      { id: 'gpt-5.5', displayName: 'GPT-5.5', contextWindow: 200_000, efforts: [], defaultEffort: null },
    ];
    const options = parseAcpConfigOptions([
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
      {
        id: 'context',
        name: 'Context',
        currentValue: '272k',
        options: [{ value: '272k', name: '272K' }, { value: '1m', name: '1M' }],
      },
    ]);
    enrichCursorModelFromConfigOptions(models, 'gpt-5.5', options);
    expect(models[0]).toMatchObject({
      efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],
      defaultEffort: 'medium',
      contextWindow: 272_000,
    });

    // 回写时必须发回该模型自己的拼写，否则上游 Invalid value。
    const effortOpt = findCursorEffortOption(options)!;
    expect(effortOpt.id).toBe('reasoning');
    expect(toCursorConfigEffortValue(effortOpt, 'xhigh')).toBe('extra-high');
    expect(toCursorConfigEffortValue(effortOpt, 'minimal')).toBe('none');
    expect(toCursorConfigEffortValue(effortOpt, 'max')).toBeNull();
  });

  it('clears effort when option absent', () => {
    const models: CursorListedModel[] = [
      {
        id: 'auto',
        displayName: 'Auto',
        contextWindow: 200_000,
        efforts: ['high'],
        defaultEffort: 'high',
        supportsFastMode: true,
      },
    ];
    enrichCursorModelFromConfigOptions(models, 'auto', []);
    expect(models[0]).toMatchObject({
      efforts: [],
      defaultEffort: null,
      supportsFastMode: false,
    });
  });
});

describe('cursorAutoModelFallback', () => {
  it('provides selectable Auto when catalog is empty', () => {
    expect(cursorAutoModelFallback().id).toBe('auto');
  });
});
