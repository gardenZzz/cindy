// @vitest-environment jsdom

/**
 * 配置浮层的**层级逃生口**锁:宿主传下来的 z 覆盖必须落在 portal 外层包装上。
 *
 * 病根(2026-09-07 实测「自动化-创建自动化」里档位选不了):外层包装写死 `fixed z-50`,
 * 覆盖类却加在内层卡片上 —— 卡片是 position: static,z-index 对它无效;退一步说,外层
 * `fixed z-50` 本身就是层叠上下文,内层任何 z 都出不去。于是浮层恒定压在
 * ScheduleFormDialog 的 `z-[10000]` 全屏蒙层底下:看不见,点击被蒙层吃掉。
 *
 * 既有的 schedulerModelPopoverOverlay 用例挡不住这一类:它 mock 掉了 ModelSelectorContent,
 * 只断言 prop 传下去了,真浮层从没渲染过。
 */

import { render } from '@testing-library/react';
import React from 'react';
import { describe, expect, it } from 'vitest';

import { UnifiedFlyoutHost } from '../components/new-chat/UnifiedFlyoutHost';

function renderHost(className?: string) {
  const anchor = document.createElement('button');
  document.body.appendChild(anchor);
  const flyoutRef = React.createRef<HTMLDivElement>();
  const { unmount } = render(
    <UnifiedFlyoutHost
      anchorEl={anchor}
      panelElement={null}
      flyoutRef={flyoutRef}
      {...(className !== undefined ? { className } : {})}
      onDismiss={() => {}}
    >
      <span>配置</span>
    </UnifiedFlyoutHost>,
  );
  const wrapper = document.querySelector('[data-unified-flyout-wrapper]');
  const card = document.querySelector('[data-testid="unified-model-config-flyout"]');
  return { wrapper, card, unmount };
}

describe('UnifiedFlyoutHost 层级', () => {
  it('把宿主的 z 覆盖加到 portal 外层包装(定位层),不是内层卡片', () => {
    const { wrapper, card, unmount } = renderHost('z-[10020]');
    // 定位层 = 唯一能相对 body 抬层级的那一层。
    expect(wrapper?.className).toContain('fixed');
    expect(wrapper?.className).toContain('z-[10020]');
    // twMerge 必须把默认的 z-50 顶掉,否则两个 z 类同时在场、结果看声明顺序。
    expect(wrapper?.className).not.toContain('z-50');
    // 内层卡片是 static,拿到 z 也没用 —— 不许再往这儿加。
    expect(card?.className).not.toContain('z-[10020]');
    unmount();
  });

  it('宿主不传时保留默认 z-50(聊天 composer 的 MorphPopover 同层)', () => {
    const { wrapper, unmount } = renderHost();
    expect(wrapper?.className).toContain('z-50');
    unmount();
  });
});
