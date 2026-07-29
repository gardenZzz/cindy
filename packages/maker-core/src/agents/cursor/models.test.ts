import { describe, expect, it } from 'vitest';

import {
  CURSOR_ACP_AUTO_MODEL_ID,
  CURSOR_PRODUCT_AUTO_MODEL_ID,
  cursorAutoModelFallback,
  cursorListingToDescriptors,
  enrichCursorModelFromConfigOptions,
  parseAcpConfigOptions,
  parseCursorModelsState,
  toCursorAcpModelId,
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
