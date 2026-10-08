import { describe, expect, it } from 'vitest';

import {
  effectiveAgentDeviceId,
  intentChangesAgentLocation,
  mobileAgentLabel,
  mobileAgentShortLabel,
  mobileAgentLabelFromUnknown,
  mobileAgentVendor,
  normalizeSessionAgentSwitchIntent,
  readAgentSwitchLocationTarget,
  resolveAgentLocationPick,
  sessionAgentKind,
  sessionAgentRunsOnOtherComputer,
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

describe('remote Agent location (Agent runs on another computer)', () => {
  const remoteSession = { agentDeviceId: 'device-office-pc' };
  const localSession = { agentDeviceId: null };
  const intentTo = (agentDeviceId: string | null) => ({
    targetAgentKind: 'claude-code' as const, model: 'm', providerId: null, agentDeviceId,
  });

  it('keeps the optional agentDeviceId of a pending intent', () => {
    expect(normalizeSessionAgentSwitchIntent({
      targetAgentKind: 'claude-code',
      model: 'claude-sonnet-4-6',
      providerId: 'anthropic',
      agentDeviceId: null,
    })).toEqual({
      targetAgentKind: 'claude-code',
      model: 'claude-sonnet-4-6',
      providerId: 'anthropic',
      agentDeviceId: null,
    });
    expect(normalizeSessionAgentSwitchIntent({
      targetAgentKind: 'codex', model: 'gpt-5.5', providerId: null, agentDeviceId: 'device-office-pc',
    })).toEqual({
      targetAgentKind: 'codex', model: 'gpt-5.5', providerId: null, agentDeviceId: 'device-office-pc',
    });
    // 缺省 = 位置不变,不补出该键。
    expect(normalizeSessionAgentSwitchIntent({
      targetAgentKind: 'codex', model: 'gpt-5.5', providerId: null,
    })).not.toHaveProperty('agentDeviceId');
    // 脏值与其它字段同口径判非法。
    expect(normalizeSessionAgentSwitchIntent({
      targetAgentKind: 'codex', model: 'gpt-5.5', providerId: null, agentDeviceId: 42,
    })).toBeNull();
    expect(normalizeSessionAgentSwitchIntent({
      targetAgentKind: 'codex', model: 'gpt-5.5', providerId: null, agentDeviceId: '',
    })).toBeNull();
  });

  it('tells where the Agent runs now and for the next message', () => {
    expect(sessionAgentRunsOnOtherComputer(remoteSession)).toBe(true);
    expect(sessionAgentRunsOnOtherComputer({ agentDeviceId: null })).toBe(false);
    expect(sessionAgentRunsOnOtherComputer({ agentDeviceId: '' })).toBe(false);
    expect(sessionAgentRunsOnOtherComputer({})).toBe(false);
    expect(sessionAgentRunsOnOtherComputer(null)).toBe(false);
    expect(intentChangesAgentLocation(intentTo(null))).toBe(true);
    expect(intentChangesAgentLocation(intentTo('device-studio-mac'))).toBe(true);
    expect(intentChangesAgentLocation({ targetAgentKind: 'codex', model: 'm', providerId: null })).toBe(false);
    expect(intentChangesAgentLocation(null)).toBe(false);
    expect(effectiveAgentDeviceId(remoteSession, null)).toBe('device-office-pc');
    expect(effectiveAgentDeviceId(localSession, null)).toBeNull();
    expect(effectiveAgentDeviceId(remoteSession, intentTo(null))).toBeNull();
    expect(effectiveAgentDeviceId(localSession, intentTo('device-studio-mac'))).toBe('device-studio-mac');
    // 不带位置的意图(只换引擎 / 模型)不改位置。
    expect(effectiveAgentDeviceId(remoteSession, {
      targetAgentKind: 'codex', model: 'm', providerId: null,
    })).toBe('device-office-pc');
  });

  it('switches directly inside the same computer', () => {
    // 被控电脑上的任务选被控电脑的模型;另一台电脑上的任务选那台的模型。
    expect(resolveAgentLocationPick({ session: localSession, intent: null, catalogDeviceId: null }))
      .toEqual({ relocateTo: undefined, needsConfirm: false });
    expect(resolveAgentLocationPick({
      session: remoteSession, intent: null, catalogDeviceId: 'device-office-pc',
    })).toEqual({ relocateTo: undefined, needsConfirm: false });
  });

  it('asks before moving the Agent to another computer and carries the new location', () => {
    expect(resolveAgentLocationPick({
      session: localSession, intent: null, catalogDeviceId: 'device-studio-mac',
    })).toEqual({ relocateTo: 'device-studio-mac', needsConfirm: true });
    // 改回被控电脑同样是换电脑(null = 被控电脑)。
    expect(resolveAgentLocationPick({ session: remoteSession, intent: null, catalogDeviceId: null }))
      .toEqual({ relocateTo: null, needsConfirm: true });
    expect(resolveAgentLocationPick({
      session: remoteSession, intent: null, catalogDeviceId: 'device-studio-mac',
    })).toEqual({ relocateTo: 'device-studio-mac', needsConfirm: true });
  });

  it('does not ask again within an already confirmed move, nor when undoing it', () => {
    // 已确认换到工作室 Mac:在那台的目录里改选,继续带位置、不再问。
    expect(resolveAgentLocationPick({
      session: localSession, intent: intentTo('device-studio-mac'), catalogDeviceId: 'device-studio-mac',
    })).toEqual({ relocateTo: 'device-studio-mac', needsConfirm: false });
    // 选回任务当前所在电脑 = 撤销挂着的换位置:不带位置、不问。
    expect(resolveAgentLocationPick({
      session: localSession, intent: intentTo('device-studio-mac'), catalogDeviceId: null,
    })).toEqual({ relocateTo: undefined, needsConfirm: false });
    // 挂着换位置时又换到第三台电脑:要再问一次。
    expect(resolveAgentLocationPick({
      session: localSession, intent: intentTo('device-studio-mac'), catalogDeviceId: 'device-office-pc',
    })).toEqual({ relocateTo: 'device-office-pc', needsConfirm: true });
  });

  it('reads the boundary location only when the Agent changed computers', () => {
    expect(readAgentSwitchLocationTarget(undefined)).toBeNull();
    expect(readAgentSwitchLocationTarget({ fromAgentKind: 'cc', toAgentKind: 'codex' })).toBeNull();
    expect(readAgentSwitchLocationTarget({ toAgentDeviceId: null, toAgentDeviceName: 'Studio Mac' }))
      .toEqual({ kind: 'named', name: 'Studio Mac' });
    expect(readAgentSwitchLocationTarget({ toAgentDeviceId: null, toAgentDeviceName: null }))
      .toEqual({ kind: 'thisComputer' });
    expect(readAgentSwitchLocationTarget({ toAgentDeviceId: 'device-office-pc', toAgentDeviceName: ' ' }))
      .toEqual({ kind: 'otherComputer' });
  });
});
