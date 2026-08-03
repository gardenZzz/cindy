/**
 * ACP available_commands_update → Cindy agent-skill palette 条目。
 *
 * 磁盘 skill（~/.agents/skills、~/.cursor/skills）由 customization-scanner 扫；
 * 本模块只处理 ACP 运行时上报，并与磁盘结果按名合并。
 * 未知 / 畸形条目跳过，整包非法时返回空数组（调用方清空会话清单）。
 */

import type { AgentSkillCommand } from '../../types/palette.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface AcpAvailableCommand {
  name: string;
  description?: string;
  inputHint?: string;
}

/**
 * 从 session/update params 解析 available_commands_update。
 * 不是该 kind 或 availableCommands 非数组 → null（调用方勿清空）。
 * kind 正确但条目全坏 → 空数组（调用方应清空陈旧清单）。
 */
export function parseAvailableCommandsUpdate(
  params: unknown,
): AcpAvailableCommand[] | null {
  if (!isRecord(params)) return null;
  const update = params.update;
  if (!isRecord(update) || update.sessionUpdate !== 'available_commands_update') {
    return null;
  }
  const raw = update.availableCommands;
  if (!Array.isArray(raw)) return [];
  const out: AcpAvailableCommand[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    if (typeof item.name !== 'string' || !item.name.trim()) continue;
    const name = item.name.trim().replace(/^\//, '');
    if (!name) continue;
    const description =
      typeof item.description === 'string' && item.description.trim()
        ? item.description.trim()
        : undefined;
    let inputHint: string | undefined;
    if (isRecord(item.input) && typeof item.input.hint === 'string' && item.input.hint.trim()) {
      inputHint = item.input.hint.trim();
    }
    out.push({
      name,
      ...(description ? { description } : {}),
      ...(inputHint ? { inputHint } : {}),
    });
  }
  return out;
}

/** 投影为 ChatInput `/` palette 的 agent-skill 条目。 */
export function toAgentSkillCommands(
  commands: readonly AcpAvailableCommand[],
): AgentSkillCommand[] {
  return commands.map((cmd) => {
    const parts = [cmd.description, cmd.inputHint ? `(${cmd.inputHint})` : undefined].filter(
      Boolean,
    );
    return {
      kind: 'agent-skill' as const,
      name: cmd.name,
      ...(parts.length > 0 ? { description: parts.join(' ') } : {}),
      source: 'user' as const,
      enabled: true,
    };
  });
}

/**
 * 磁盘 skill ∪ ACP 运行时命令。同名保留磁盘条目（带 path）；ACP 补磁盘没有的内置/额外命令。
 */
export function mergeDiskAndRuntimeSkills(
  disk: readonly AgentSkillCommand[],
  runtime: readonly AgentSkillCommand[],
): AgentSkillCommand[] {
  const byName = new Map<string, AgentSkillCommand>();
  for (const skill of disk) byName.set(skill.name, skill);
  for (const skill of runtime) {
    if (!byName.has(skill.name)) byName.set(skill.name, skill);
  }
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}
