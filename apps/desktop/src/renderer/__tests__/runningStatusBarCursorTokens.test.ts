/**
 * issue #6: Cursor ACP 上游不上报 usage 时,状态栏不得显示误导性的「0 tokens」。
 * 源码契约锁住 call site(hideTokenCount={isCursor})与 RunningStatusBar 门控。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const source = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'CCAgentSessionView.tsx'),
  'utf8',
);

describe('RunningStatusBar cursor token degradation', () => {
  it('does not render token copy for cursor sessions', () => {
    expect(source).toContain('hideTokenCount={isCursor}');

    const barStart = source.indexOf('function RunningStatusBar(');
    expect(barStart).toBeGreaterThan(-1);
    const barEnd = source.indexOf('function formatTokenCount', barStart);
    const bar = source.slice(barStart, barEnd);
    expect(bar).toContain('hideTokenCount');
    expect(bar).toContain('!sideTaskRunning && !hideTokenCount');
    // 非 cursor 路径仍渲染 tokens 文案(走 i18n turnTokens + pending 占位);
    // 隐藏门控不得删掉整段计数逻辑。
    expect(bar).toContain('formatRunningTokenCount(animatedTokens, visible)');
    expect(bar).toContain('{tokenText}');
  });
});
