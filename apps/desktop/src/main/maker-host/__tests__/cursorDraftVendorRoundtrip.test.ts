import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  agentKindToDraftPushSlot,
  agentKindToDraftVendor,
  isMakerCoreAgentKind,
} from '../../../shared/agentKindDraftVendor.js';
import {
  buildNewMakerDraftChangedPayload,
  getRemoteNewMakerDefaults,
  setNewMakerDraftCache,
  type NewMakerDraftSnapshot,
} from '../newMakerDefaultsCache.js';

const here = dirname(fileURLToPath(import.meta.url));

function seed(snapshot: NewMakerDraftSnapshot): void {
  setNewMakerDraftCache(snapshot);
}

describe('cursor AgentKind→DraftVendor 草稿偏好链', () => {
  beforeEach(() => {
    seed({
      lastByVendor: {
        cc: {
          model: 'claude-opus-4-8',
          effort: 'xhigh',
          permissionMode: 'bypassPermissions',
          providerId: 'anthropic',
        },
        codex: { model: 'gpt-5.4', effort: 'high' },
        cursor: {
          model: 'auto',
          effort: 'medium',
          permissionMode: 'auto',
          providerId: null,
        },
      },
      fastModeByModel: { auto: true, 'claude-opus-4-8': true },
      effortByModel: { auto: 'low', 'claude-opus-4-8': 'high' },
    });
  });

  it('GET cursor 读 cursor 槽，不回落 codex（修复前二元映射会读到 gpt-5.4）', () => {
    expect(agentKindToDraftVendor('cursor')).toBe('cursor');
    const got = getRemoteNewMakerDefaults('cursor');
    expect(got.model).toBe('auto');
    expect(got.effort).toBe('medium');
    expect(got.fastMode).toBe(true);
    expect(got.model).not.toBe('gpt-5.4');
  });

  it('agent=cursor 的 GET→APPLY 语义更新→push 往返走 cursor 槽', () => {
    // 1) GET：控制端 seed 用
    expect(getRemoteNewMakerDefaults('cursor').model).toBe('auto');

    // 2) APPLY：agent=cursor 必须被主进程接受（修复前 INVALID_PARAMS）
    expect(isMakerCoreAgentKind('cursor')).toBe(true);
    // 模拟被控端 renderer 落盘后再 SYNC（App 会把 cursor 槽推进 cache）
    seed({
      lastByVendor: {
        cc: {
          model: 'claude-opus-4-8',
          effort: 'xhigh',
          permissionMode: 'bypassPermissions',
          providerId: 'anthropic',
        },
        codex: { model: 'gpt-5.4', effort: 'high' },
        cursor: {
          model: 'composer-1',
          effort: 'xhigh',
          permissionMode: 'auto',
          providerId: null,
        },
      },
      fastModeByModel: { 'composer-1': false, auto: true },
      effortByModel: { 'composer-1': 'xhigh' },
    });

    // 3) push：NEW_MAKER_DRAFT_CHANGED 必须含 cursor 槽（修复前只有 claudeCode/codex）
    const payload = buildNewMakerDraftChangedPayload();
    expect(Object.keys(payload).sort()).toEqual(['claudeCode', 'codex', 'cursor']);
    expect(payload[agentKindToDraftPushSlot('cursor')]).toMatchObject({
      model: 'composer-1',
      effort: 'xhigh',
      fastMode: false,
    });
    // 不串槽：claudeCode / codex 保持原样
    expect(payload.claudeCode.model).toBe('claude-opus-4-8');
    expect(payload.codex.model).toBe('gpt-5.4');
  });

  it('register APPLY/SET_SESSION 与 NewMakerDraftRoute push 槽复用唯一映射（非二元兜底）', () => {
    const registerSrc = readFileSync(join(here, '../../maker-ipc/register.ts'), 'utf8');
    // 合并后 register 用显式四元校验(含 pi),不再走 isMakerCoreAgentKind 助手;
    // 关键不变量:不得回落二元 claude-code|codex 兜底。
    expect(registerSrc).toContain("p.agent !== 'claude-code' && p.agent !== 'codex' && p.agent !== 'cursor' && p.agent !== 'pi'");
    expect(registerSrc).toContain('buildNewMakerDraftChangedPayload()');
    expect(registerSrc.match(/p\.agent !== 'claude-code' && p\.agent !== 'codex' && p\.agent !== 'cursor' && p\.agent !== 'pi'/g)?.length).toBeGreaterThanOrEqual(3);
    expect(registerSrc).not.toMatch(
      /p\.agent !== 'claude-code' && p\.agent !== 'codex'\)/,
    );

    const routeSrc = readFileSync(
      join(here, '../../../renderer/features/cc-agent/NewMakerDraftRoute.tsx'),
      'utf8',
    );
    expect(routeSrc).toContain('agentKindToDraftPushSlot(capabilityAgentKind)');
    expect(routeSrc).not.toContain(
      "capabilityAgentKind === 'codex' ? 'codex' : 'claudeCode'",
    );

    const appSrc = readFileSync(join(here, '../../../renderer/App.tsx'), 'utf8');
    expect(appSrc).toContain('agentKindToDraftVendor(agent)');
    expect(appSrc).toContain('cursor: {');
    expect(appSrc).toContain('draft.lastByVendor.cursor.model');
  });
});
