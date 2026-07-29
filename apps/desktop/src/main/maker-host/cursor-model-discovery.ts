/**
 * cursor-model-discovery —— 把 Cursor ACP session/new 上报的模型清单映射为
 * maker-core ModelDescriptor[]，供 host 注入 CursorAgent.capabilities.availableModels。
 *
 * 与 codex-model-discovery 同构：maker-core 只负责调用时机，映射 / 落盘 / 广播归 host。
 */

import type { ModelDescriptor } from '@cindy/maker-core';
import {
  cursorListingToDescriptors,
  type CursorModelsListing,
} from '@cindy/maker-core';

/** ACP 上报 → 产品目录描述符。空 listing 返回 []（调用方保留 Auto 兜底）。 */
export function mapCursorAcpModelsToDescriptors(
  listing: CursorModelsListing,
): ModelDescriptor[] {
  return cursorListingToDescriptors(listing.models);
}
