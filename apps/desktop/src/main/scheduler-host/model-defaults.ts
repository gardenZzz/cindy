/**
 * model-defaults — 调度域"留空走默认"的 model 兜底(单一来源)
 * ---------------------------------------------------------------------------
 * 与 renderer useScheduleForm.ts `schedulerFallbackModel` 同步:cc →
 * claude-sonnet-4-6,codex → gpt-5.5,cursor → auto。**故意不跟对话的 Opus
 * 默认**——自动化无人值守反复执行,冷启动兜底走成本保守路线,要 Opus 的用户
 * 会显式选;Cursor 产品面静态默认 Auto(id `auto`,与 T4 CURSOR_PRODUCT_AUTO_MODEL_ID
 * 对齐)。
 * ⚠️ 必须与 UI 空值回退(ModelEffortChip / getScheduleDefaultModel)一致,
 * 否则"UI 显示 X 实跑 Y"(2026-06 实踩:显示 Opus 4.8、跑的 4.7)。消费方:
 * runner(agent 任务 fire)与 script-capability-broker(sessions.dispatch 的
 * createDefaults)——先前各持一份拷贝,review 后收敛到本文件。
 */
import type { AgentKind } from '@cindy/maker-scheduler';

export function defaultModelFor(agentKind: AgentKind): string {
  if (agentKind === 'codex') return 'gpt-5.5';
  if (agentKind === 'cursor') return 'auto';
  return 'claude-sonnet-4-6';
}
