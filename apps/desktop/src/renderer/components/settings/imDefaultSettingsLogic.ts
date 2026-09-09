import type {
  ImDefaultAgentKind,
  ImDefaultAgentSettings,
  ImDefaultEffort,
  ImDefaultSettingsPatch,
  ImDefaultSettingsState,
} from '../../../shared/imDefaultSettings';

/**
 * 切 harness 时把目标 agent 的模型/供应商/思考强度一并收敛到当前可用清单。
 *
 * 为何必需: 切 agent 只写 agentKind 时, 目标 agent 带的是上次(或出厂默认)
 * 的 model —— 那个模型可能已停用、供应商已断开或从未接入。UI 会照显,
 * 而 headless runner 派发时才静默降级换模型, 用户无感。changeModel 一直
 * 做这层收敛, changeAgent 漏了 —— 两边必须同口径。
 *
 * available 为空(该 agent 当下一个可用模型都没有)时原样保留已存值: 宁可
 * 维持用户选过的值, 也不把它抹成空字符串。
 */
export function resolveAgentSwitchSettings(args: {
  current: ImDefaultAgentSettings;
  available: ReadonlyArray<{ id: string; efforts?: readonly string[] }>;
  /**
   * 强度解析, **必须传 changeModel 用的那一个**(组件里的 resolveEffort)。
   */
  resolveEffort: (modelId: string, requested: ImDefaultEffort) => ImDefaultEffort;
  resolveProviderId: (modelId: string, providerId: string | null) => string | null;
}): ImDefaultAgentSettings {
  const { current, available, resolveEffort, resolveProviderId } = args;
  if (available.length === 0) return current;
  const keptModel = available.find((m) => m.id === current.model);
  const model = keptModel ?? available[0]!;
  return {
    model: model.id,
    providerId: resolveProviderId(model.id, keptModel ? current.providerId : null),
    effort: resolveEffort(model.id, current.effort),
  };
}

export function buildAgentSettingsPatch(
  agentKind: ImDefaultAgentKind,
  nextSettings: ImDefaultAgentSettings,
): ImDefaultSettingsPatch {
  return {
    agents: {
      [agentKind]: nextSettings,
    },
  };
}

export function mergeSettingsPatch(
  settings: ImDefaultSettingsState,
  patch: ImDefaultSettingsPatch,
): ImDefaultSettingsState {
  return {
    ...settings,
    ...patch,
    agents: patch.agents ? { ...settings.agents, ...patch.agents } : settings.agents,
    isCustomized: true,
  };
}
