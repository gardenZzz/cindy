import { useEffect, useState } from 'react';

/**
 * 本机是否已装 cursor-agent —— 用于翻开各处的 Cursor 选择段（New Maker vendor
 * 分段、Orca worker 创建面板、协同 worker 选择 popover）。
 *
 * 未装时一律不露出 Cursor 入口：选了也只会在 spawn 阶段失败。
 * 探测失败按「未装」处理（fail-closed）。
 */
export function useCursorAvailable(): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let cancelled = false;
    // preload 未装配（单测 / 分离窗口早期帧）时按未装处理，不抛。
    const probe = window.electronAPI?.maker?.agent?.getCursorBinaryStatus;
    if (!probe) return;
    void Promise.resolve(probe())
      .then((status) => {
        if (!cancelled) setAvailable(status.installed);
      })
      .catch(() => {
        if (!cancelled) setAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return available;
}
