/**
 * Cursor ACP 上游不上报 usage(usage_update 不发送、PromptResponse.usage 为空)时,
 * 上下文圆环不得显示误导性的「0 / 200K (0%)」—— 那是"无数据",不是"空上下文"。
 * 与 issue #6 状态栏 hideTokenCount={isCursor} 同一处理:拿到真实数据前不渲染。
 * 源码契约锁住 ContextCapacityRing 调用点的门控表达式。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const source = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'CCAgentSessionView.tsx'),
  'utf8',
);

describe('ContextCapacityRing cursor usage degradation', () => {
  it('does not render the ring for cursor sessions until real usage data arrives', () => {
    const ringCall = source.indexOf('<ContextCapacityRing');
    expect(ringCall).toBeGreaterThan(-1);

    // 门控表达式必须就在调用点之前:!isCursor 或任一真实 usage 信号。
    const gateStart = source.lastIndexOf('{(!isCursor', ringCall);
    expect(gateStart).toBeGreaterThan(-1);
    const gate = source.slice(gateStart, ringCall);
    expect(gate).toContain('agentStatus.contextTokens > 0');
    expect(gate).toContain('agentStatus.contextWindow > 0');
  });

  it('keeps the ring rendered for non-cursor agents', () => {
    // 门控是「非 cursor 恒真」的析取式,不能把整个圆环删成 cursor-only 逻辑。
    const ringCall = source.indexOf('<ContextCapacityRing');
    const gateStart = source.lastIndexOf('{(!isCursor', ringCall);
    const gate = source.slice(gateStart, ringCall);
    expect(gate).toMatch(/\!isCursor\s*\|\|/);
  });
});
