import { describe, expect, it } from 'vitest';

import type { ModelPriceQuote } from '../../../shared/regionalMoney';
import {
  formatModelPricePair,
  modelPriceDiscountLabelValues,
  modelPriceDetailRows,
  modelPricePresentation,
} from '../modelPriceFormat';

function quote(overrides: Partial<ModelPriceQuote> = {}): ModelPriceQuote {
  return {
    providerId: 'xd',
    modelId: 'claude-sonnet-4',
    currency: 'CNY',
    source: 'gateway',
    approximate: false,
    inputPerMtok: 3,
    outputPerMtok: 15,
    ...overrides,
  };
}

describe('modelPriceFormat', () => {
  it('formats gateway CNY input/output as a compact pair', () => {
    expect(formatModelPricePair(quote())).toBe('¥3 / ¥15');
  });

  it('adds the approximate marker only once', () => {
    expect(
      formatModelPricePair(
        quote({
          source: 'subscription-reference',
          approximate: true,
          inputPerMtok: 20.1,
          outputPerMtok: 100.5,
        }),
      ),
    ).toBe('≈¥20.1 / ¥100.5');
  });

  it('includes configured cache prices in details', () => {
    expect(
      modelPriceDetailRows(quote({ cacheReadPerMtok: 0.3, cacheCreatePerMtok: 3.75 })),
    ).toEqual([
      { kind: 'input', value: '¥3' },
      { kind: 'output', value: '¥15' },
      { kind: 'cacheRead', value: '¥0.3' },
      { kind: 'cacheCreate', value: '¥3.75' },
    ]);
  });

  it('presents a discounted quote with its carried originals and badge values', () => {
    const discounted = quote({
      inputPerMtok: 6,
      outputPerMtok: 18,
      cacheReadPerMtok: 0.15,
      discount: 0.5,
      originalInputPerMtok: 12,
      originalOutputPerMtok: 36,
      originalCacheReadPerMtok: 0.3,
    });
    expect(modelPricePresentation(discounted, { input: 6, output: 18 })).toEqual({
      kind: 'priced',
      current: quote({ inputPerMtok: 6, outputPerMtok: 18, cacheReadPerMtok: 0.15 }),
      original: quote({ inputPerMtok: 12, outputPerMtok: 36, cacheReadPerMtok: 0.3 }),
      discount: 0.5,
    });
    expect(modelPriceDiscountLabelValues(0.5)).toEqual({
      percent: '50',
      rate: '5',
    });
    expect(modelPriceDiscountLabelValues(0.2)).toEqual({
      percent: '20',
      rate: '8',
    });
    expect(
      modelPriceDetailRows(
        quote({ inputPerMtok: 6, outputPerMtok: 18, cacheReadPerMtok: 0.15 }),
        quote({ inputPerMtok: 12, outputPerMtok: 36, cacheReadPerMtok: 0.3 }),
      ),
    ).toEqual([
      { kind: 'input', value: '¥6', originalValue: '¥12' },
      { kind: 'output', value: '¥18', originalValue: '¥36' },
      { kind: 'cacheRead', value: '¥0.15', originalValue: '¥0.3' },
    ]);
  });

  it('marks only an all-zero cost with a confirmed missing quote as free', () => {
    expect(modelPricePresentation(null, { input: 0, output: 0 })).toEqual({
      kind: 'free',
    });
    expect(
      modelPricePresentation(null, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
    ).toEqual({ kind: 'free' });
    expect(modelPricePresentation(undefined, { input: 0, output: 0 })).toBeNull();
    // 缓存维度带价 ⇒ 不是免费模型;标准报价被 0/0 规则丢弃后宁可不展示价格。
    expect(modelPricePresentation(null, { input: 0, output: 0, cacheRead: 8.4 })).toBeNull();
    expect(modelPricePresentation(null, { input: 0, output: 0, cacheWrite: 15 })).toBeNull();
  });

  it('keeps a 100% discounted quote as a discount, never as free', () => {
    const fullDiscount = quote({
      inputPerMtok: 0,
      outputPerMtok: 0,
      discount: 1,
      originalInputPerMtok: 12,
      originalOutputPerMtok: 36,
    });
    expect(modelPricePresentation(fullDiscount, { input: 0, output: 0 })).toEqual({
      kind: 'priced',
      current: quote({ inputPerMtok: 0, outputPerMtok: 0 }),
      original: quote({ inputPerMtok: 12, outputPerMtok: 36 }),
      discount: 1,
    });
  });

  it('preserves the standard price when the quote carries no discount', () => {
    const standard = quote({ inputPerMtok: 12, outputPerMtok: 36 });
    expect(modelPricePresentation(standard, { input: 12, output: 36 })).toEqual({
      kind: 'priced',
      current: standard,
    });
  });

  it('ignores sub-threshold discounts on the quote', () => {
    const noisy = quote({
      inputPerMtok: 12,
      outputPerMtok: 36,
      discount: 1e-12,
      originalInputPerMtok: 12,
      originalOutputPerMtok: 36,
    });
    expect(modelPricePresentation(noisy, { input: 12, output: 36 })).toEqual({
      kind: 'priced',
      current: noisy,
    });
  });

  it('never derives a discount from catalog costs alone', () => {
    const standard = quote({ inputPerMtok: 12, outputPerMtok: 36 });
    expect(modelPricePresentation(standard, { input: 6, output: 18 })).toEqual({
      kind: 'priced',
      current: standard,
    });
    expect(modelPricePresentation(standard, { input: 6 })).toEqual({
      kind: 'priced',
      current: standard,
    });
    expect(modelPricePresentation(undefined, { input: 0 })).toBeNull();
  });
});
