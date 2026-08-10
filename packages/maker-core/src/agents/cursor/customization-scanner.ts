/**
 * Cursor 文件系统 customization scanner。
 *
 * 扫描路径:
 *   ~/.agents/skills/{name}/SKILL.md        → kind=skill, scope=user (跨引擎共享)
 *   ~/.cursor/skills/{name}/SKILL.md        → kind=skill, scope=user
 *   {workingDir}/.agents/skills/{name}/...  → kind=skill, scope=repo
 *   {workingDir}/.cursor/skills/{name}/...  → kind=skill, scope=repo
 *
 * ChatInput `/` palette 与 SkillHub 共用；不扫 skills-cursor（上游内置同步目录）。
 */

import os from 'node:os';
import path from 'node:path';

import type {
  ListCustomizationsOptions,
  ListCustomizationsResult,
} from '../../types/customizations.js';
import { scanCustomizationSources, type SourceDef } from '../shared/customization-scanner.js';

function buildCursorSources(workingDirs: string[], homeDir: string = os.homedir()): SourceDef[] {
  const sources: SourceDef[] = [
    { engine: 'cursor', kind: 'skill', scope: 'user', dir: path.join(homeDir, '.agents', 'skills') },
    { engine: 'cursor', kind: 'skill', scope: 'user', dir: path.join(homeDir, '.cursor', 'skills') },
  ];
  for (const wd of workingDirs) {
    if (!wd || !path.isAbsolute(wd)) continue;
    sources.push(
      {
        engine: 'cursor',
        kind: 'skill',
        scope: 'repo',
        dir: path.join(wd, '.agents', 'skills'),
        workingDir: wd,
      },
      {
        engine: 'cursor',
        kind: 'skill',
        scope: 'repo',
        dir: path.join(wd, '.cursor', 'skills'),
        workingDir: wd,
      },
    );
  }
  return sources;
}

export async function scanCursorCustomizations(
  opts: ListCustomizationsOptions & { homeDir?: string },
): Promise<ListCustomizationsResult> {
  if (opts.kinds && opts.kinds.length > 0 && !opts.kinds.includes('skill')) {
    return { items: [], errors: [] };
  }

  const sources = buildCursorSources(opts.workingDirs ?? [], opts.homeDir);
  const result = scanCustomizationSources(sources, null);

  result.items.sort((a, b) => {
    if (a.scope !== b.scope) return a.scope.localeCompare(b.scope);
    return a.name.localeCompare(b.name);
  });

  return result;
}
