import { describe, expect, it } from 'vitest';

import {
  mobileAgentLabel,
  mobileAgentShortLabel,
  mobileAgentLabelFromUnknown,
  mobileAgentVendor,
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
    expect(toMakerAgentKind('pi')).toBe('pi');
    expect(toDbAgentKind('claude-code')).toBe('cc');
    expect(toDbAgentKind('codex')).toBe('codex');
    expect(toDbAgentKind('cursor')).toBe('cursor');
    expect(toDbAgentKind('pi')).toBe('pi');
    expect(sessionAgentKind({ agentKind: 'cc' })).toBe('claude-code');
    expect(sessionAgentKind({ agentKind: 'codex' })).toBe('codex');
    expect(sessionAgentKind({ agentKind: 'cursor' })).toBe('cursor');
    expect(sessionAgentKind({ agentKind: 'pi' })).toBe('pi');
    expect(mobileAgentLabel('claude-code')).toBe('Claude Code');
    expect(mobileAgentLabel('codex')).toBe('Codex');
    expect(mobileAgentLabel('cursor')).toBe('Cursor');
    expect(mobileAgentLabel('pi')).toBe('Pi');
    expect(mobileAgentShortLabel('claude-code')).toBe('Claude');
    expect(mobileAgentShortLabel('cursor')).toBe('Cursor');
    expect(mobileAgentShortLabel('pi')).toBe('Pi');
    expect(mobileAgentLabelFromUnknown('pi')).toBe('Pi');
    expect(mobileAgentLabelFromUnknown('cursor')).toBe('Cursor');
    expect(mobileAgentVendor('claude-code')).toBe('cc');
    expect(mobileAgentVendor('codex')).toBe('codex');
    expect(mobileAgentVendor('cursor')).toBe('cursor');
    expect(mobileAgentVendor('pi')).toBe('pi');
    expect(normalizeSessionAgentSwitchIntent({
      targetAgentKind: 'pi', model: 'gpt-5.5', providerId: 'openai',
    })).toEqual({ targetAgentKind: 'pi', model: 'gpt-5.5', providerId: 'openai' });
  });

  it('requires host capability and excludes SSH / Orca sessions', () => {
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
    // 四家同口径:Cursor 源会话纯粹依赖被控端能力位--新被控端报 true 即显示,
    // 老被控端报 false 即隐藏(优雅降级,升级后自然获得)。不再在客户端写死排除。
    expect(supportsMobileSessionAgentSwitch(
      { remoteHostId: null, orcaRole: null, agentKind: 'cursor' },
      supported,
    )).toBe(true);
    expect(supportsMobileSessionAgentSwitch(
      { remoteHostId: null, orcaRole: null, agentKind: 'cursor' },
      { ...supported, supportsSessionAgentSwitch: false },
    )).toBe(false);
  });
});
