/**
 * ADR 0006 的守卫：让用户挑 Harness 的入口不得自行枚举取值，一律问运行时 roster。
 *
 * 为什么要读源码而不是跑渲染：这几个入口的渲染测试都把 roster hook mock 掉了，
 * 只能证明「入口照单渲染」，证明不了「入口去问了那个 hook」。上游重构时按它认识的
 * 那几个 Harness 重写入口、塞回一串写死的字面量——正是 Cursor 从四个入口同时消失
 * 的原因——那些渲染测试连同 roster hook 自己的测试可以全绿。检测器必须换判据才有
 * 判别力。同形态的源文本断言见 newMakerOrcaCreateOrder.test.ts。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/** 让用户挑 Harness 并保存的入口。新增同类入口时补进来。 */
const HARNESS_ENTRIES = {
  '自动化': ['features', 'scheduler', 'components', 'ScheduleChips.tsx'],
  'IM 默认设置': ['components', 'settings', 'ImDefaultSettingsSection.tsx'],
  'Hook 工作目录偏好': ['components', 'settings', 'HookWorkspacePrefsEditor.tsx'],
  '协同 worker 创建': ['features', 'cc-agent', 'CreateWorkerPopover.tsx'],
} as const;

function sourceOf(segments: readonly string[]): string {
  return readFileSync(resolve(__dirname, '..', ...segments), 'utf8');
}

/**
 * 写死的 Harness 清单长什么样：一个含 `'claude-code'` 且**不止一项**的数组字面量。
 *
 * 两条判据各有分工：
 * - 含 `'claude-code'` —— 把**能力子集**放行。`fastModeConfigurable={['codex',
 *   'cursor', 'pi']}` 这类清单按定义排除 Claude（Claude 恒不传 Fast），而 Harness
 *   全集必然含它。
 * - 不止一项 —— 把 `fromProviders['claude-code']` 这种带引号的下标访问放行。
 *
 * 上游那串 `['claude-code', 'codex', 'pi']` 两条都命中。
 */
function hardcodedHarnessList(source: string): string | null {
  for (const [, inner] of source.matchAll(/\[([^\]]*)\]/g)) {
    if (inner.includes("'claude-code'") && inner.includes(',')) return `[${inner}]`;
  }
  return null;
}

describe('Harness 入口一律走运行时 roster（ADR 0006）', () => {
  for (const [label, segments] of Object.entries(HARNESS_ENTRIES)) {
    const source = sourceOf(segments);

    it(`${label}：问 roster 要可选集合`, () => {
      expect(source).toContain('useModelPickerAgents(');
    });

    it(`${label}：不自行枚举 Harness 取值`, () => {
      expect(hardcodedHarnessList(source)).toBeNull();
    });

    it(`${label}：不并挂第二个 Harness 控件`, () => {
      // model-selector-unified.md「设置类入口」：经 onUnifiedSelect 一次提交，
      // 删除重复的 Harness 控件。
      expect(source).not.toContain("from '@/components/new-chat/AgentSelect'");
    });
  }

  it('守卫本身有判别力：抓得住写死清单，放得过能力子集与下标访问', () => {
    expect(hardcodedHarnessList("unifiedAgents={['claude-code', 'codex', 'pi']}")).not.toBeNull();
    expect(hardcodedHarnessList("pickerAgents ?? ['claude-code', 'codex']")).not.toBeNull();
    expect(hardcodedHarnessList("fastModeConfigurable={['codex', 'cursor', 'pi']}")).toBeNull();
    expect(hardcodedHarnessList("fromProviders['claude-code'].length")).toBeNull();
  });
});
