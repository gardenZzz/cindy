/**
 * openBackgroundTasksTab —— "打开右栏「后台任务」面板"的统一程序化入口。
 *
 * 范式对齐 openInSidebarBrowser:ensureHydrated → addOrFocusSingletonTab →
 * requestRightSidebarVisibility。差异:
 *  - 单例 kind:已有 tab 时聚焦而非新开(与 review 同款语义)。
 *  - focusTaskId(可选):写进 tab state,Body 消费后进对应 workflow 详情并清空;
 *    tab 已存在时经 patchTabState 补写(store 无单例 state patch 快捷 API)。
 *  - detached 路由:RsbWindowCommand 目前没有 background-tasks 命令类型,不走
 *    routeSidebarCommand —— 只走本窗口路径;子窗口形态的路由支持归后续阶段
 *    (届时在 shared/rightSidebarWindow.ts 扩 command union 后接 routeSidebarCommand)。
 */

import { addOrFocusSingletonTab, ensureHydrated, getBucket, patchTabState } from '../store';
import { requestRightSidebarVisibility } from './sidebarCommands';

/** 打开(或聚焦)指定 session 的后台任务面板,并确保侧边栏可见。 */
export async function openBackgroundTasksTab(
  sessionId: string,
  opts?: { focusTaskId?: string },
): Promise<void> {
  // addOrFocusSingletonTab 的乐观写以 bucket 已 hydrate 为前提(与
  // openUrlInSidebarBrowser 同款竞态说明);已 hydrate 时是同步 no-op。
  await ensureHydrated(sessionId);
  const hadExisting = getBucket(sessionId).tabs.some((t) => t.kind === 'background-tasks');
  const tab = await addOrFocusSingletonTab(sessionId, 'background-tasks', {
    focusTaskId: opts?.focusTaskId ?? null,
  });
  // 已有 tab 时 initialState 不生效,focusTaskId 需补写进现有 state。
  if (hadExisting && opts?.focusTaskId) {
    await patchTabState(sessionId, tab.id, (current) => {
      const base =
        typeof current === 'object' && current !== null
          ? (current as Record<string, unknown>)
          : {};
      return { ...base, focusTaskId: opts.focusTaskId };
    });
  }
  requestRightSidebarVisibility('open', { sessionId });
}
