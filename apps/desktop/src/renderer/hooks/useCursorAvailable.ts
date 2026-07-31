import { useEffect, useSyncExternalStore } from 'react';

import {
  getCursorAvailability,
  peekCursorAvailability,
  subscribeCursorAvailability,
} from '@/state/cursorAvailability';

/**
 * 本机是否已装 cursor-agent —— 用于翻开各处的 Cursor 选择段（New Maker vendor
 * 分段、Orca worker 创建面板、协同 worker 选择 popover）。
 *
 * 探测结果由 `@/state/cursorAvailability` 全局缓存（启动预热 + 单飞行），这里只订阅。
 */

/**
 * 三态：`null` = 探测未回。
 *
 * 需要据此做**破坏性动作**（如把草稿 vendor 翻走）的调用方必须用这个版本，
 * 把未知与「确认没装」区分开；只是显示/隐藏入口的用 {@link useCursorAvailable}。
 */
export function useCursorAvailability(): boolean | null {
  // 第三参(server snapshot)必传:部分单测走 react-dom/server 渲染,缺它会直接抛。
  // 服务端快照与客户端同源 —— 缓存是模块级的,两侧读同一份。
  const value = useSyncExternalStore(
    subscribeCursorAvailability,
    peekCursorAvailability,
    peekCursorAvailability,
  );
  useEffect(() => {
    void getCursorAvailability();
  }, []);
  return value;
}

/** 未装 / 未知都按不露出处理（fail-closed）。 */
export function useCursorAvailable(): boolean {
  return useCursorAvailability() === true;
}
