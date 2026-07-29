import { describe, expect, it } from 'vitest';

import {
  mobileAgentLabel,
  mobileAgentShortLabel,
  normalizeSessionAgentSwitchIntent,
  sessionAgentKind,
  supportsMobileSessionAgentSwitch,
  toDbAgentKind,
  toMakerAgentKind,
} from '@/session/sessionAgentSwitch';
import type { MobileAgentCapabilities } from '@/session/agentCapabilities';

describe('mobile session Agent switch contract', () => {
  it('normalizes only the public pending intent fields', () => {
    expect(normalizeSessionAgentSwitchIntent({
      targetAgentKind: 'codex',
      model: 'gpt-5.5',
      providerId: null,
      effort: 'high',
      fastMode: true,
      resumeFallbackRecovery: { handoff: 'must stay on desktop main' },
    })).toEqual({
      targetAgentKind: 'codex',
      model: 'gpt-5.5',
      providerId: null,
      effort: 'high',
      fastMode: true,
    });
    expect(normalizeSessionAgentSwitchIntent({
      targetAgentKind: 'cursor',
      model: 'auto',
      providerId: null,
    })).toEqual({
      targetAgentKind: 'cursor',
      model: 'auto',
      providerId: null,
    });
    expect(normalizeSessionAgentSwitchIntent(null)).toBeNull();
    expect(normalizeSessionAgentSwitchIntent({ targetAgentKind: 'codex', model: '' })).toBeNull();
    expect(normalizeSessionAgentSwitchIntent({
      targetAgentKind: 'gemini', model: 'x', providerId: null,
    })).toBeNull();
    // providerId 缺失(undefined)按 null 处理,不丢弃合法 intent(对齐桌面 `providerId ?? null`)。
    expect(normalizeSessionAgentSwitchIntent({
      targetAgentKind: 'codex', model: 'gpt-5.5',
    })).toEqual({ targetAgentKind: 'codex', model: 'gpt-5.5', providerId: null });
    // 只有非 string / 非 null / 非 undefined 的脏值才判非法。
    expect(normalizeSessionAgentSwitchIntent({
      targetAgentKind: 'codex', model: 'gpt-5.5', providerId: 123,
    })).toBeNull();
  });

  it('maps DB Agent kinds and labels consistently', () => {
    expect(toMakerAgentKind('cc')).toBe('claude-code');
    expect(toMakerAgentKind('codex')).toBe('codex');
    expect(toMakerAgentKind('cursor')).toBe('cursor');
    expect(toDbAgentKind('claude-code')).toBe('cc');
    expect(toDbAgentKind('codex')).toBe('codex');
    expect(toDbAgentKind('cursor')).toBe('cursor');
    expect(sessionAgentKind({ agentKind: 'cc' })).toBe('claude-code');
    expect(sessionAgentKind({ agentKind: 'codex' })).toBe('codex');
    expect(sessionAgentKind({ agentKind: 'cursor' })).toBe('cursor');
    expect(mobileAgentLabel('claude-code')).toBe('Claude Code');
    expect(mobileAgentLabel('codex')).toBe('Codex');
    expect(mobileAgentLabel('cursor')).toBe('Cursor');
    expect(mobileAgentShortLabel('claude-code')).toBe('Claude');
    expect(mobileAgentShortLabel('cursor')).toBe('Cursor');
  });

  it('requires host capability and excludes SSH / Orca / Cursor-source sessions', () => {
    const supported: MobileAgentCapabilities = {
      availableModels: [],
      effortLevels: [],
      permissionModes: [],
      hasFastMode: false,
      planModeSupported: false,
      supportsSessionAgentSwitch: true,
    };
    expect(supportsMobileSessionAgentSwitch({ remoteHostId: null, orcaRole: null, agentKind: 'cc' }, supported)).toBe(true);
    expect(supportsMobileSessionAgentSwitch({ remoteHostId: 'ssh-1', orcaRole: null, agentKind: 'cc' }, supported)).toBe(false);
    expect(supportsMobileSessionAgentSwitch({ remoteHostId: null, orcaRole: 'lead', agentKind: 'cc' }, supported)).toBe(false);
    expect(supportsMobileSessionAgentSwitch(
      { remoteHostId: null, orcaRole: null, agentKind: 'cc' },
      { ...supported, supportsSessionAgentSwitch: false },
    )).toBe(false);
    expect(supportsMobileSessionAgentSwitch({ remoteHostId: null, orcaRole: null, agentKind: 'cc' }, null)).toBe(false);
    // 从 Cursor 会话切走仍不支持；切「到」Cursor 由新 desktop handler 承接。
    expect(supportsMobileSessionAgentSwitch(
      { remoteHostId: null, orcaRole: null, agentKind: 'cursor' },
      supported,
    )).toBe(false);
  });
});
