/**
 * Cursor ACP 模型目录 / config options 解析。
 *
 * ACP 用 modelId `default` 表示 Auto；Cindy 产品面统一用 `auto`（与 New Maker /
 * mobile 种子默认对齐）。effort / fast 来自 session/set_config_option 返回的
 * 参数化 configOptions，不硬编码进目录。
 */

import type { Effort } from '../../types/common.js';
import type { ModelDescriptor } from '../../types/capabilities.js';
import type {
  AcpConfigOption,
  AcpModelsState,
} from '../acp/protocol.js';

/** ACP Auto 哨兵 ↔ Cindy 产品 id。 */
export const CURSOR_ACP_AUTO_MODEL_ID = 'default';
export const CURSOR_PRODUCT_AUTO_MODEL_ID = 'auto';

/**
 * 推理强度在上游有两个承载 id：Claude / Gemini 家族叫 `effort`，GPT / Kimi / GLM
 * 家族叫 `reasoning`（实测 cursor-agent 2026.07）。只认 `effort` 会让 GPT-5.x /
 * Codex / Kimi / GLM 这半边模型永远没有推理强度可选。
 */
const CURSOR_EFFORT_CONFIG_IDS: readonly string[] = ['effort', 'reasoning'];

/**
 * 上游取值 → Cindy Effort。同一档位在不同模型上拼写不同（`extra-high` 与 `xhigh`、
 * `none` 与 `minimal`），回写时必须按该模型自报的拼写发回，见 toCursorConfigEffortValue。
 */
const CURSOR_EFFORT_VALUES: Readonly<Record<string, Effort>> = {
  none: 'minimal',
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  'extra-high': 'xhigh',
  max: 'max',
};

export interface CursorListedModel {
  /** Cindy 产品 model id（`default` 已映射为 `auto`）。 */
  id: string;
  displayName: string;
  contextWindow: number;
  efforts: readonly Effort[];
  defaultEffort: Effort | null;
  supportsFastMode?: boolean;
  /** 当前模型是否暴露 ACP `thinking` 开关（Claude Opus 系常见）。 */
  supportsThinkingMode?: boolean;
}

export interface CursorModelsListing {
  currentModelId: string;
  models: readonly CursorListedModel[];
}

export function toCursorProductModelId(acpOrProductId: string): string {
  return acpOrProductId === CURSOR_ACP_AUTO_MODEL_ID
    ? CURSOR_PRODUCT_AUTO_MODEL_ID
    : acpOrProductId;
}

export function toCursorAcpModelId(productOrAcpId: string): string {
  return productOrAcpId === CURSOR_PRODUCT_AUTO_MODEL_ID
    ? CURSOR_ACP_AUTO_MODEL_ID
    : productOrAcpId;
}

export function cursorAutoModelFallback(): CursorListedModel {
  return {
    id: CURSOR_PRODUCT_AUTO_MODEL_ID,
    displayName: 'Auto',
    contextWindow: 200_000,
    efforts: [],
    defaultEffort: null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** 解析 session/new.models；失败 / 空目录 → null（调用方保留兜底）。 */
export function parseCursorModelsState(raw: unknown): CursorModelsListing | null {
  if (!isRecord(raw)) return null;
  const currentRaw = raw.currentModelId;
  if (typeof currentRaw !== 'string' || currentRaw.length === 0) return null;
  const available = raw.availableModels;
  if (!Array.isArray(available) || available.length === 0) return null;

  const models: CursorListedModel[] = [];
  const seen = new Set<string>();
  for (const item of available) {
    if (!isRecord(item)) continue;
    const modelId = item.modelId;
    const name = item.name;
    if (typeof modelId !== 'string' || modelId.length === 0) continue;
    const id = toCursorProductModelId(modelId);
    if (seen.has(id)) continue;
    seen.add(id);
    models.push({
      id,
      displayName: typeof name === 'string' && name.length > 0 ? name : id,
      contextWindow: 200_000,
      efforts: [],
      defaultEffort: null,
    });
  }
  if (models.length === 0) return null;
  return {
    currentModelId: toCursorProductModelId(currentRaw),
    models,
  };
}

export function parseAcpConfigOptions(raw: unknown): AcpConfigOption[] {
  if (!Array.isArray(raw)) return [];
  const out: AcpConfigOption[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const id = item.id;
    const currentValue = item.currentValue;
    if (typeof id !== 'string' || typeof currentValue !== 'string') continue;
    const optionsRaw = item.options;
    const options = Array.isArray(optionsRaw)
      ? optionsRaw.flatMap((opt) => {
          if (!isRecord(opt)) return [];
          const value = opt.value;
          const name = opt.name;
          if (typeof value !== 'string' || typeof name !== 'string') return [];
          return [
            {
              value,
              name,
              ...(typeof opt.description === 'string'
                ? { description: opt.description }
                : {}),
            },
          ];
        })
      : [];
    out.push({
      id,
      name: typeof item.name === 'string' ? item.name : id,
      ...(typeof item.description === 'string' ? { description: item.description } : {}),
      ...(typeof item.category === 'string' ? { category: item.category } : {}),
      ...(typeof item.type === 'string' ? { type: item.type } : {}),
      currentValue,
      options,
    });
  }
  return out;
}

function parseContextWindow(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === '1m' || normalized === '1000k') return 1_000_000;
  const m = /^(\d+)k$/.exec(normalized);
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0) return n * 1000;
  }
  const asNum = Number(normalized);
  if (Number.isFinite(asNum) && asNum > 0) return asNum;
  return undefined;
}

/** 上游取值 → Cindy Effort；不认识的档位返回 null（丢弃，不猜）。 */
export function toCursorEffort(value: string): Effort | null {
  return CURSOR_EFFORT_VALUES[value] ?? null;
}

/** 该模型承载推理强度的 configOption(`effort` 或 `reasoning`)；没有则 undefined。 */
export function findCursorEffortOption(
  configOptions: readonly AcpConfigOption[],
): AcpConfigOption | undefined {
  return configOptions.find((o) => CURSOR_EFFORT_CONFIG_IDS.includes(o.id));
}

/**
 * Cindy Effort → 该模型 configOption 里的原始取值。按模型自报的清单挑拼写
 * （xhigh 在有的模型上叫 extra-high），挑不到返回 null = 该模型不支持这一档。
 */
export function toCursorConfigEffortValue(
  option: AcpConfigOption,
  effort: Effort,
): string | null {
  return option.options.find((o) => CURSOR_EFFORT_VALUES[o.value] === effort)?.value ?? null;
}

/**
 * 用 set_config_option 回包丰富某一模型的 effort / fast / context。
 * 就地改 listing（同 id 条目）；找不到则 no-op。
 */
export function enrichCursorModelFromConfigOptions(
  listing: CursorListedModel[],
  productModelId: string,
  configOptions: readonly AcpConfigOption[],
): void {
  const target = listing.find((m) => m.id === productModelId);
  if (!target) return;

  const byId = new Map(configOptions.map((o) => [o.id, o]));
  const effortOpt = findCursorEffortOption(configOptions);
  if (effortOpt) {
    const efforts = effortOpt.options
      .map((o) => toCursorEffort(o.value))
      .filter((e): e is Effort => e != null);
    target.efforts = efforts;
    const current = toCursorEffort(effortOpt.currentValue);
    target.defaultEffort = current ?? (efforts.length > 0 ? efforts[efforts.length - 1]! : null);
  } else {
    target.efforts = [];
    target.defaultEffort = null;
  }

  const fastOpt = byId.get('fast');
  target.supportsFastMode = Boolean(
    fastOpt?.options.some((o) => o.value === 'true' || o.value === 'false'),
  );

  // Cursor 后台在 Thinking+High+Fast 时会把展示 id 记成
  // `claude-opus-5-thinking-high-fast`；ACP 参数化模式下仍是干净 modelId + configOptions。
  const thinkingOpt = byId.get('thinking');
  target.supportsThinkingMode = Boolean(
    thinkingOpt?.options.some((o) => o.value === 'true' || o.value === 'false'),
  );

  const contextOpt = byId.get('context');
  const window = parseContextWindow(contextOpt?.currentValue);
  if (window != null) target.contextWindow = window;
}

export function readConfigOptionValue(
  configOptions: readonly AcpConfigOption[],
  configId: string,
): string | undefined {
  return configOptions.find((o) => o.id === configId)?.currentValue;
}

export function cursorListingToDescriptors(
  models: readonly CursorListedModel[],
): ModelDescriptor[] {
  return models.map((m) => {
    const d: ModelDescriptor = {
      id: m.id,
      displayName: m.displayName,
      contextWindow: m.contextWindow,
      efforts: m.efforts,
      defaultEffort: m.defaultEffort,
    };
    if (m.supportsFastMode !== undefined) d.supportsFastMode = m.supportsFastMode;
    if (m.supportsThinkingMode !== undefined) d.supportsThinkingMode = m.supportsThinkingMode;
    return d;
  });
}

/** 类型收窄：未知 models 字段是否为 AcpModelsState 形。 */
export function asAcpModelsState(raw: unknown): AcpModelsState | null {
  const parsed = parseCursorModelsState(raw);
  if (!parsed) return null;
  return {
    currentModelId: toCursorAcpModelId(parsed.currentModelId),
    availableModels: parsed.models.map((m) => ({
      modelId: toCursorAcpModelId(m.id),
      name: m.displayName,
    })),
  };
}
