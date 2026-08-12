// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IM_DEFAULT_SETTINGS, type ImDefaultSettingsState } from '../../../../shared/imDefaultSettings';
import { ImDefaultSettingsSection } from '../ImDefaultSettingsSection';

const capabilityMockState = vi.hoisted(() => ({
  loadingAgent: null as string | null,
  errorAgent: null as string | null,
  piTurnPermissionPolicy: null as {
    supported: { supported: true };
    unsupportedPermissionModes: string[];
  } | null,
  cursorAvailable: true,
}));

/** 捕获引擎下拉的 props —— 断言 Cursor 的可选性与选中回调。 */
const agentSelectMock = vi.hoisted(() => ({
  props: [] as Array<Record<string, unknown>>,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/useAgentCapabilities', () => {
  // Pi 未声明 turnPermissionPolicy(警告);Claude Code / Codex 声明且受支持(不警告)。
  const supported = {
    capabilities: {
      availableModels: [],
      turnPermissionPolicy: {
        supported: { supported: true },
        unsupportedPermissionModes: [],
      },
    },
    loading: false,
    error: null,
  };
  return {
    useAgentCapabilities: (agentKind: string) => {
      if (capabilityMockState.loadingAgent === agentKind) {
        return { capabilities: null, loading: true, error: null };
      }
      if (capabilityMockState.errorAgent === agentKind) {
        return { capabilities: null, loading: false, error: 'capabilities unavailable' };
      }
      return agentKind === 'pi'
        ? {
            capabilities: {
              availableModels: [],
              ...(capabilityMockState.piTurnPermissionPolicy
                ? { turnPermissionPolicy: capabilityMockState.piTurnPermissionPolicy }
                : {}),
            },
            loading: false,
            error: null,
          }
        : supported;
    },
  };
});

vi.mock('@/hooks/useProviders', () => ({
  useProviders: () => ({ providers: [] }),
}));

vi.mock('@/hooks/useCursorAvailable', () => ({
  useCursorAvailable: () => capabilityMockState.cursorAvailable,
  useCursorAvailability: () => capabilityMockState.cursorAvailable,
}));

vi.mock('@/components/new-chat/AgentSelect', () => ({
  AgentSelect: (props: Record<string, unknown>) => {
    agentSelectMock.props.push(props);
    return null;
  },
}));

vi.mock('@/components/new-chat/ModelSelector', () => ({
  ModelSelector: () => null,
}));

vi.mock('../DefaultOverrideControls', () => ({
  DefaultOverrideControls: () => null,
}));

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

function defaults(agentKind: ImDefaultSettingsState['agentKind']): ImDefaultSettingsState {
  return {
    agentKind,
    permissionMode: 'auto',
    agents: {
      'claude-code': { providerId: null, model: 'claude-opus-4-8', effort: 'xhigh' },
      codex: { providerId: null, model: 'codex/gpt-5.5', effort: 'high' },
      pi: { providerId: null, model: 'claude-sonnet-5', effort: 'high' },
      cursor: { providerId: null, model: 'auto', effort: 'high' },
    },
    isCustomized: false,
    customizedKeys: [],
    defaults: IM_DEFAULT_SETTINGS,
  };
}

describe('ImDefaultSettingsSection Pi channel warning', () => {
  beforeEach(() => {
    capabilityMockState.loadingAgent = null;
    capabilityMockState.errorAgent = null;
    capabilityMockState.piTurnPermissionPolicy = null;
    capabilityMockState.cursorAvailable = true;
    agentSelectMock.props.length = 0;
    window.electronAPI = {
      maker: {
        imDefaultSettingsGet: vi.fn(async () => defaults('pi')),
      },
    } as unknown as typeof window.electronAPI;
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('warns when Pi is selected on a turn-policy channel (wechat)', async () => {
    render(<ImDefaultSettingsSection channel="wechat" />);

    const status = await screen.findByRole('status');
    expect(status.textContent).toContain(
      'settings.imBot.defaults.agentUnsupportedOnChannelHint',
    );
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.getAttribute('aria-atomic')).toBe('true');
  });

  it('appends the permission-mode hint when the channel default mode is incompatible with the replacement agents', async () => {
    window.electronAPI = {
      maker: {
        imDefaultSettingsGet: vi.fn(async () => ({ ...defaults('pi'), permissionMode: 'bypassPermissions' })),
      },
    } as unknown as typeof window.electronAPI;
    render(<ImDefaultSettingsSection channel="wechat" />);

    const status = await screen.findByRole('status');
    expect(status.textContent).toContain(
      'settings.imBot.defaults.agentUnsupportedOnChannelHint',
    );
    expect(status.textContent).toContain(
      'settings.imBot.defaults.agentUnsupportedOnChannelModeHint',
    );
  });

  it('omits the permission-mode hint for a compatible default mode', async () => {
    render(<ImDefaultSettingsSection channel="wechat" />);

    const status = await screen.findByRole('status');
    expect(status.textContent).not.toContain(
      'settings.imBot.defaults.agentUnsupportedOnChannelModeHint',
    );
  });

  it('does not warn for Pi ask/auto once its turn policy capability supports those modes', async () => {
    capabilityMockState.piTurnPermissionPolicy = {
      supported: { supported: true },
      unsupportedPermissionModes: ['bypassPermissions'],
    };
    render(<ImDefaultSettingsSection channel="wechat" />);

    await screen.findByText('settings.imBot.defaults.agentLabel');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('warns to change permission mode when Pi supports turn policy but not Full Access', async () => {
    capabilityMockState.piTurnPermissionPolicy = {
      supported: { supported: true },
      unsupportedPermissionModes: ['bypassPermissions'],
    };
    window.electronAPI = {
      maker: {
        imDefaultSettingsGet: vi.fn(async () => ({
          ...defaults('pi'),
          permissionMode: 'bypassPermissions',
        })),
      },
    } as unknown as typeof window.electronAPI;
    render(<ImDefaultSettingsSection channel="wechat" />);

    const status = await screen.findByRole('status');
    expect(status.textContent).toContain(
      'settings.imBot.defaults.permissionModeUnsupportedOnChannelHint',
    );
    expect(status.textContent).not.toContain(
      'settings.imBot.defaults.agentUnsupportedOnChannelHint',
    );
  });

  it('does not warn for a supported agent on wechat', async () => {
    window.electronAPI = {
      maker: {
        imDefaultSettingsGet: vi.fn(async () => defaults('claude-code')),
      },
    } as unknown as typeof window.electronAPI;
    render(<ImDefaultSettingsSection channel="wechat" />);

    await screen.findByText('settings.imBot.defaults.agentLabel');
    expect(
      screen.queryByText('settings.imBot.defaults.agentUnsupportedOnChannelHint'),
    ).toBeNull();
  });

  it('does not warn while the selected Agent capabilities are loading', async () => {
    capabilityMockState.loadingAgent = 'pi';
    render(<ImDefaultSettingsSection channel="wechat" />);

    await screen.findByText('settings.imBot.defaults.agentLabel');
    expect(
      screen.queryByText('settings.imBot.defaults.agentUnsupportedOnChannelHint'),
    ).toBeNull();
  });

  it('does not warn when the selected Agent capabilities failed to load', async () => {
    capabilityMockState.errorAgent = 'pi';
    render(<ImDefaultSettingsSection channel="wechat" />);

    await screen.findByText('settings.imBot.defaults.agentLabel');
    expect(
      screen.queryByText('settings.imBot.defaults.agentUnsupportedOnChannelHint'),
    ).toBeNull();
  });

  it('does not warn for Pi on channels without turn policy (feishu)', async () => {
    render(<ImDefaultSettingsSection channel="feishu" />);

    await screen.findByText('settings.imBot.defaults.agentLabel');
    expect(
      screen.queryByText('settings.imBot.defaults.agentUnsupportedOnChannelHint'),
    ).toBeNull();
  });

  it('keeps Cursor selectable and stores it verbatim instead of falling back to Codex', async () => {
    // 历史实现是「非 cc 即 codex」的二元映射:选 Cursor 会静默存成 Codex,
    // 用户看到的就是「选不了 Cursor」。
    const setSpy = vi.fn(async () => defaults('cursor'));
    window.electronAPI = {
      maker: {
        imDefaultSettingsGet: vi.fn(async () => defaults('claude-code')),
        imDefaultSettingsSet: setSpy,
      },
    } as unknown as typeof window.electronAPI;
    agentSelectMock.props.length = 0;
    render(<ImDefaultSettingsSection channel="telegram" />);
    await screen.findByText('settings.imBot.defaults.agentLabel');

    const props = agentSelectMock.props.at(-1);
    expect(props?.hiddenVendors).toBeUndefined();
    (props?.onChange as (next: string) => void)('cursor');
    await waitFor(() => expect(setSpy).toHaveBeenCalled());

    expect(setSpy).toHaveBeenCalledWith(
      expect.objectContaining({ agentKind: 'cursor' }),
      'telegram',
    );
  });

  it('hides Cursor when cursor-agent is not installed on this machine', async () => {
    capabilityMockState.cursorAvailable = false;
    agentSelectMock.props.length = 0;
    render(<ImDefaultSettingsSection channel="telegram" />);
    await screen.findByText('settings.imBot.defaults.agentLabel');

    expect(agentSelectMock.props.at(-1)?.hiddenVendors).toContain('cursor');
  });

  it('does not warn for Pi on conditional-policy channels (telegram / dingtalk)', async () => {
    // Telegram / 钉钉仅在群聊(event.speaker 存在)挂 turnPermissionPolicy,
    // 主人私聊 Pi 可用;设置 UI 不区分群聊/私聊,不能整体警告。
    const first = render(<ImDefaultSettingsSection channel="telegram" />);
    await first.findByText('settings.imBot.defaults.agentLabel');
    expect(
      screen.queryByText('settings.imBot.defaults.agentUnsupportedOnChannelHint'),
    ).toBeNull();
    cleanup();

    const second = render(<ImDefaultSettingsSection channel="dingtalk" />);
    await second.findByText('settings.imBot.defaults.agentLabel');
    expect(
      screen.queryByText('settings.imBot.defaults.agentUnsupportedOnChannelHint'),
    ).toBeNull();
  });
});
