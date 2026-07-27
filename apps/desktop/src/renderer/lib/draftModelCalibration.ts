/**
 * 草稿默认模型的可用性校准。
 *
 * 新建草稿的种子模型是**写死的产品默认**（cc → Opus、codex → GPT），与「这台机器上
 * 到底连了哪些来源」完全无关。全新用户的可连来源未必提供那个 id —— 于是首屏就落在一个
 * 没有任何已连接来源的模型上，Send 被禁用、只能弹「当前模型没有已连接的来源」，用户还
 * 没开始用就先撞墙。
 *
 * 这里只校准**用户从没显式选过**的默认值（`modelChosenByVendor` 区分「真选过」与
 * 「默认回填」）。用户自己选的模型一律不动：他选了什么就该看到什么，静默改写比撞墙更糟
 * ——那会让「我明明选了 Codex」变成无法自查的错觉。
 */

import {
  connectedProvidersForAgent,
  type AgentKind,
  type CatalogModel,
  type ProviderView,
} from '@cindy/model-providers';

/**
 * 在该 agent 的已连接来源里挑一个模型 id：
 *   1. 首选 `preferredModelId`（默认值本身可用就不要动它，避免首屏莫名换模型）；
 *   2. 否则取已连接来源提供的第一个模型（provider 顺序 = 目录顺序，确定性）；
 *   3. 一个已连接来源都没有 → null，交给既有的「零来源」空态引导去连接供应商。
 */
export function pickConnectedModelForAgent(
  providers: readonly ProviderView[],
  agent: AgentKind,
  preferredModelId: string,
  excludeModel?: (model: CatalogModel, providerId: string) => boolean,
): string | null {
  const connected = connectedProvidersForAgent([...providers], agent);
  if (connected.length === 0) return null;
  const usable = (provider: ProviderView): CatalogModel[] =>
    (provider.models[agent] ?? []).filter((m) => !excludeModel?.(m, provider.id));
  for (const provider of connected) {
    if (usable(provider).some((m) => m.id === preferredModelId)) return preferredModelId;
  }
  for (const provider of connected) {
    const first = usable(provider)[0];
    if (first) return first.id;
  }
  return null;
}

export interface DraftModelCalibrationInput {
  providers: readonly ProviderView[];
  agent: AgentKind;
  /** 草稿当前的模型（种子默认或用户选择）。 */
  model: string;
  /** 用户是否在选择器里显式选过该 vendor 的模型。 */
  chosenByUser: boolean;
  /** 供应商清单是否仍在加载：加载期不校准，避免首帧把默认模型闪成别的。 */
  providersLoading: boolean;
  /**
   * 逐模型排除（与选择器的可见性口径同源）。两类必须在这里判，供应商级过滤盖不住——
   * 同一个供应商可能既有可路由 / 可见的模型，又有该排除的模型：
   *   - **用户隐藏或默认收起的模型**：`ModelSelector` 用 `isModelEnabled` 过滤，校准若扫
   *     原始清单，会选中一个选择器里根本看不到的模型，与用户的可见性设置直接冲突；
   *   - **订阅直连模型**（`chatgpt/` / `xai/`，仅 SSH 远程草稿）：bridge 只挂在本地
   *     compat-proxy，远程模式不经它，选中必失败。
   */
  excludeModel?: (model: CatalogModel, providerId: string) => boolean;
}

/** 返回草稿应当展示 / 发送的模型 id（不可校准时原样返回，绝不返回空）。 */
export function calibrateDraftModel({
  providers,
  agent,
  model,
  chosenByUser,
  providersLoading,
  excludeModel,
}: DraftModelCalibrationInput): string {
  if (chosenByUser || providersLoading) return model;
  return pickConnectedModelForAgent(providers, agent, model, excludeModel) ?? model;
}
