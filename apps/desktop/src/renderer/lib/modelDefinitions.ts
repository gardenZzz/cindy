/**
 * 兼容层 —— 历史代码用 `getModelById` / `getDefaultModelForVendor` 同步查模型,
 * 数据现在的 SSoT 在 maker-core (通过 useAgentCapabilities hook 异步拉取并缓存)。
 *
 * 本文件不再持有任何模型数据, 只把缓存里的 ModelDescriptor 适配成历史调用方
 * 期待的形状 (label / vendorKey 等)。
 *
 * 在 callback / 同步逻辑里使用; render 路径请直接用 useAgentCapabilities。
 */

import { getCachedCapabilities, type ModelDescriptor } from '@/hooks/useAgentCapabilities';
import type { Effort } from '@/lib/userPreferences.types';

export interface ModelDefinition {
  id: string;
  label: string;
  description: string;
  efforts: readonly Effort[];
  defaultEffort: Effort | null;
  vendorKey: 'cc' | 'codex';
  contextWindow?: number;
  supportsFastMode?: boolean;
  supportsThinkingMode?: boolean;
}

function toLegacy(m: ModelDescriptor, vendorKey: 'cc' | 'codex'): ModelDefinition {
  return {
    id: m.id,
    label: m.displayName,
    description: m.description ?? '',
    efforts: m.efforts,
    defaultEffort: m.defaultEffort,
    vendorKey,
    contextWindow: m.contextWindow,
    supportsFastMode: m.supportsFastMode,
    supportsThinkingMode: m.supportsThinkingMode,
  };
}

// device-link「以被控端为准」:可选 deviceId 决定读哪份能力缓存。省略 = 本机缓存(行为不变);
// 传 deviceId = 该被控端的缓存(远程会话的模型/effort/contextWindow 必须来自被控端,模型 id
// 跨设备不唯一,绝不能用本地缓存替代)。
function allCachedModels(deviceId?: string): ModelDefinition[] {
  const cc = getCachedCapabilities('claude-code', deviceId);
  const codex = getCachedCapabilities('codex', deviceId);
  return [
    ...((cc?.availableModels ?? []).map((m) => toLegacy(m, 'cc'))),
    ...((codex?.availableModels ?? []).map((m) => toLegacy(m, 'codex'))),
  ];
}

/**
 * 老调用方期待的"全模型列表" —— 用 getter 形式确保每次访问都是最新缓存,
 * 而不是 module load 时的一次性快照。
 */
export const MODELS = new Proxy([] as ModelDefinition[], {
  get(_t, prop) {
    const arr = allCachedModels();
    // @ts-expect-error proxy index forward
    return arr[prop];
  },
}) as readonly ModelDefinition[];

export function getEffortsForModel(modelId: string, deviceId?: string): readonly Effort[] {
  return getModelById(modelId, deviceId)?.efforts ?? [];
}

export function downgradeEffort(
  currentEffort: Effort,
  newModelId: string,
  deviceId?: string,
): Effort | null {
  const allowed = getEffortsForModel(newModelId, deviceId);
  if (allowed.length === 0) return null;
  if (allowed.includes(currentEffort)) return currentEffort;
  return allowed[allowed.length - 1];
}

/**
 * 按 ID 找模型; 兼容 'gpt-5-codex' 老 ID (DB 存量)。
 * 新代码尽量直接遍历 capabilities; 这里只给老调用方收口。
 */
export function getModelById(modelId: string, deviceId?: string): ModelDefinition | undefined {
  const all = allCachedModels(deviceId);
  if (modelId === 'gpt-5-codex') {
    return all.find((m) => m.id === 'gpt-5.5');
  }
  // 兼容长 ID Haiku 老存量数据
  if (modelId === 'claude-haiku-4-5-20251001') {
    return all.find((m) => m.id === 'claude-haiku-4-5');
  }
  return all.find((m) => m.id === modelId);
}

export function getModelsForVendor(
  vendorKey: 'cc' | 'codex',
  deviceId?: string,
): readonly ModelDefinition[] {
  return allCachedModels(deviceId).filter((m) => m.vendorKey === vendorKey);
}

export function getDefaultModelForVendor(vendorKey: 'cc' | 'codex', deviceId?: string): ModelDefinition {
  const list = getModelsForVendor(vendorKey, deviceId);
  // capabilities 还没拉到时退化到一个静态 placeholder, 让调用方拿到非 undefined。
  // 调用方真正需要值时通常已经在 useEffect 后, capabilities 已就绪。
  if (list.length === 0) {
    return {
      id: vendorKey === 'codex' ? 'gpt-5.5' : 'claude-opus-4-8',
      label: vendorKey === 'codex' ? 'GPT-5.5' : 'Opus 4.8',
      description: '',
      efforts: [],
      defaultEffort: null,
      vendorKey,
    };
  }
  // cc 默认走 opus-4-8, codex 默认走 gpt-5.5 —— 这是**对话**场景的默认。
  // 自动化任务（scheduler）的默认**故意不同**:无人值守场景成本保守,
  // 走 useScheduleForm.ts getScheduleDefaultModel 三级回退（冷启动 Sonnet）,
  // 不要把这里的 Opus 默认接到 scheduler 上。
  const preferredId = vendorKey === 'codex' ? 'gpt-5.5' : 'claude-opus-4-8';
  return list.find((m) => m.id === preferredId) ?? list[0];
}
