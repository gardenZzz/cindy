import type { ModelPriceQuote, MoneyCurrency } from '../../shared/regionalMoney';

interface EffectiveModelCost {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

const MIN_DISPLAY_DISCOUNT = 0.0005;

export type ModelPricePresentation =
  | { kind: 'free' }
  | {
      kind: 'priced';
      current: ModelPriceQuote;
      original?: ModelPriceQuote;
      discount?: number;
    };

function compactNumber(value: number): string {
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: value > 0 && value < 0.01 ? 4 : 2,
    useGrouping: false,
  }).format(value);
}

export function formatModelPriceAmount(amount: number, currency: MoneyCurrency): string {
  return `${currency === 'CNY' ? '¥' : '$'}${compactNumber(amount)}`;
}

export function formatModelPricePair(quote: ModelPriceQuote): string {
  const input = formatModelPriceAmount(quote.inputPerMtok, quote.currency);
  const output = formatModelPriceAmount(quote.outputPerMtok, quote.currency);
  return `${quote.approximate ? '≈' : ''}${input} / ${output}`;
}

export function modelPriceDiscountLabelValues(discount: number): {
  percent: string;
  rate: string;
} {
  return {
    percent: compactNumber(discount * 100),
    rate: compactNumber((1 - discount) * 10),
  };
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * 构建模型选择器的展示价格。quote 即实付口径——Gateway costDiscount 已在构建
 * quote 时套用(shared/modelPriceQuote.ts),用量记账与展示同价;折扣前原价由
 * quote.original* 承载。CatalogModel.cost 只作为「明确全零 → 免费」的证据
 * (含缓存维度),不再参与折扣推断。
 */
export function modelPricePresentation(
  quote: ModelPriceQuote | null | undefined,
  effectiveCost: EffectiveModelCost | null | undefined,
): ModelPricePresentation | null {
  if (quote === undefined) return null;

  if (quote === null) {
    // 免费证据链:价格快照已成功加载但确认无该模型报价(quote === null),且目录
    // cost 的所有计费维度(含缓存)都明确为 0。任何维度带价都不许出免费标签。
    const input = effectiveCost?.input;
    const output = effectiveCost?.output;
    const allDimensionsZero =
      isNonNegativeFinite(input) &&
      input === 0 &&
      isNonNegativeFinite(output) &&
      output === 0 &&
      (effectiveCost?.cacheRead === undefined || effectiveCost.cacheRead === 0) &&
      (effectiveCost?.cacheWrite === undefined || effectiveCost.cacheWrite === 0);
    return allDimensionsZero ? { kind: 'free' } : null;
  }

  if (
    quote.discount !== undefined &&
    quote.discount >= MIN_DISPLAY_DISCOUNT &&
    quote.originalInputPerMtok !== undefined &&
    quote.originalOutputPerMtok !== undefined
  ) {
    const {
      discount,
      originalInputPerMtok,
      originalOutputPerMtok,
      originalCacheReadPerMtok,
      originalCacheCreatePerMtok,
      ...current
    } = quote;
    const original: ModelPriceQuote = {
      ...current,
      inputPerMtok: originalInputPerMtok,
      outputPerMtok: originalOutputPerMtok,
      ...(originalCacheReadPerMtok !== undefined
        ? { cacheReadPerMtok: originalCacheReadPerMtok }
        : {}),
      ...(originalCacheCreatePerMtok !== undefined
        ? { cacheCreatePerMtok: originalCacheCreatePerMtok }
        : {}),
    };
    return { kind: 'priced', current, original, discount };
  }
  return { kind: 'priced', current: quote };
}

export function modelPriceDetailRows(
  quote: ModelPriceQuote,
  originalQuote?: ModelPriceQuote,
): Array<{
  kind: 'input' | 'output' | 'cacheRead' | 'cacheCreate';
  value: string;
  originalValue?: string;
}> {
  return [
    {
      kind: 'input' as const,
      value: formatModelPriceAmount(quote.inputPerMtok, quote.currency),
      ...(originalQuote
        ? {
            originalValue: formatModelPriceAmount(
              originalQuote.inputPerMtok,
              originalQuote.currency,
            ),
          }
        : {}),
    },
    {
      kind: 'output' as const,
      value: formatModelPriceAmount(quote.outputPerMtok, quote.currency),
      ...(originalQuote
        ? {
            originalValue: formatModelPriceAmount(
              originalQuote.outputPerMtok,
              originalQuote.currency,
            ),
          }
        : {}),
    },
    ...(quote.cacheReadPerMtok === undefined
      ? []
      : [
          {
            kind: 'cacheRead' as const,
            value: formatModelPriceAmount(quote.cacheReadPerMtok, quote.currency),
            ...(originalQuote?.cacheReadPerMtok !== undefined
              ? {
                  originalValue: formatModelPriceAmount(
                    originalQuote.cacheReadPerMtok,
                    originalQuote.currency,
                  ),
                }
              : {}),
          },
        ]),
    ...(quote.cacheCreatePerMtok === undefined
      ? []
      : [
          {
            kind: 'cacheCreate' as const,
            value: formatModelPriceAmount(quote.cacheCreatePerMtok, quote.currency),
            ...(originalQuote?.cacheCreatePerMtok !== undefined
              ? {
                  originalValue: formatModelPriceAmount(
                    originalQuote.cacheCreatePerMtok,
                    originalQuote.currency,
                  ),
                }
              : {}),
          },
        ]),
  ];
}
