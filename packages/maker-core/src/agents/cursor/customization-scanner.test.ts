/**
 * Cursor 磁盘 skill 发现单测 —— 不 spawn cursor-agent。
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { scanCursorCustomizations } from './customization-scanner.js';

describe('scanCursorCustomizations', () => {
  let root = '';
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'cursor-skills-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('discovers user skills from ~/.agents/skills and ~/.cursor/skills', async () => {
    const home = path.join(root, 'home');
    const agentsSkill = path.join(home, '.agents', 'skills', 'to-tickets');
    const cursorSkill = path.join(home, '.cursor', 'skills', 'demo-cursor');
    mkdirSync(agentsSkill, { recursive: true });
    mkdirSync(cursorSkill, { recursive: true });
    writeFileSync(
      path.join(agentsSkill, 'SKILL.md'),
      '---\nname: to-tickets\ndescription: Break into tickets\n---\n# To Tickets\n',
    );
    writeFileSync(
      path.join(cursorSkill, 'SKILL.md'),
      '---\nname: demo-cursor\ndescription: Cursor-only skill\n---\n# Demo\n',
    );

    const result = await scanCursorCustomizations({ workingDirs: [], homeDir: home });
    const names = result.items.map((i) => i.name).sort();
    expect(names).toEqual(['demo-cursor', 'to-tickets']);
    expect(result.items.every((i) => i.engine === 'cursor' && i.scope === 'user')).toBe(true);
  });

  it('discovers project skills under .agents/skills and .cursor/skills', async () => {
    const home = path.join(root, 'empty-home');
    mkdirSync(home, { recursive: true });
    const workingDir = path.join(root, 'repo');
    const agentsSkill = path.join(workingDir, '.agents', 'skills', 'repo-agents');
    const cursorSkill = path.join(workingDir, '.cursor', 'skills', 'repo-cursor');
    mkdirSync(agentsSkill, { recursive: true });
    mkdirSync(cursorSkill, { recursive: true });
    writeFileSync(path.join(agentsSkill, 'SKILL.md'), '---\ndescription: agents repo\n---\n');
    writeFileSync(path.join(cursorSkill, 'SKILL.md'), '---\ndescription: cursor repo\n---\n');

    const result = await scanCursorCustomizations({ workingDirs: [workingDir], homeDir: home });
    expect(result.items.map((i) => i.name).sort()).toEqual(['repo-agents', 'repo-cursor']);
    expect(result.items.every((i) => i.scope === 'repo')).toBe(true);
  });
});
