import { describe, expect, it } from 'vitest';

import { mapCursorAcpModelsToDescriptors } from '../cursor-model-discovery.js';

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
