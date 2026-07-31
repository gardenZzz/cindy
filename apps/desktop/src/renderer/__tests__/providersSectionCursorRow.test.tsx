// @vitest-environment jsdom

/**
 * ProvidersSection — Cursor 进入左栏列表(设置页伪行,非可路由供应商)不变量:
 *   1. 未装 cursor-agent 也出现左栏行(点进去是引导),且页面不再有底部独立大卡片。
 *   2. 选中 Cursor 行 → 右栏是安装/登录详情;真实供应商详情让位。
 *   3. 已安装已登录 → 右栏给登出入口。
 *   4. Cursor 详情不出现「停用供应商 / 刷新内置模型」等仅真实供应商才有的动作。
 *   5. connect=cursor 深链直接选中该行,不开向导。
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderView } from '@cindy/model-providers';

const { wizardSpy, providersState, cursorState } = vi.hoisted(() => ({
  wizardSpy: vi.fn(),
  providersState: { providers: [] as unknown[] },
  cursorState: {
    installed: false,
    auth: { authenticated: false } as { authenticated: boolean; identity?: string },
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'zh-CN' } }),
}));

vi.mock('@/hooks/useProviders', () => ({
  useProviders: () => ({ providers: providersState.providers, loading: false, refetch: vi.fn() }),
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ mode: 'cloud', exitLocalMode: vi.fn(async () => undefined) }),
}));

vi.mock('@/hooks/useCodexAuth', () => ({
  isChatGptConnectionConnected: () => false,
  useCodexAuth: () => ({
    state: { kind: 'unauthenticated' },
    triggerLogin: vi.fn(),
    cancelLogin: vi.fn(),
    logout: vi.fn(),
  }),
}));

vi.mock('@/hooks/useApiKey', () => ({
  useApiKey: () => ({ key: '', hasSavedKey: false, clearKey: vi.fn() }),
}));

vi.mock('@/hooks/useModelAccessStatus', () => ({
  useModelAccessStatus: () => ({ state: 'failed', source: null, endpoint: null }),
}));

vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(async () => true) }),
}));

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('@/lib/customProviders', () => ({
  deleteCustomProvider: vi.fn(),
  readCustomProviderKey: vi.fn(async () => null),
  updateCustomProvider: vi.fn(),
}));

vi.mock('@/lib/providerModels', () => ({
  providerMonogram: () => 'X',
}));

vi.mock('@/lib/providerSubtitle', () => ({
  customProviderSubtitleForDisplay: () => '',
  providerSubtitleForDisplay: () => 'subtitle',
}));

vi.mock('@/state/modelVisibilityPrefs', () => ({
  isModelEnabled: () => true,
  setManyVisibility: vi.fn(),
  setModelVisibility: vi.fn(),
  useModelVisibilityVersion: () => 0,
}));

vi.mock('@/components/settings/CustomProviderDialog', () => ({
  CustomProviderDialog: () => null,
}));

vi.mock('@/components/settings/AddProviderWizard', () => ({
  AddProviderWizard: (props: { entry?: unknown }) => {
    wizardSpy(props.entry);
    return React.createElement('div', { 'data-testid': 'wizard-stub' });
  },
}));

import { ProvidersSection } from '@/components/settings/ProvidersSection';

import { __testing as cursorAvailabilityTesting } from '@/state/cursorAvailability';

function makeProvider(id: string, over?: Partial<ProviderView>): ProviderView {
  return {
    id,
    name: id,
    source: 'builtin',
    agents: ['claude-code'],
    auth: { method: 'oauth' },
    routing: {},
    models: { 'claude-code': [] },
    connected: false,
    ...over,
  } as unknown as ProviderView;
}

function renderAt(search = '?tab=providers') {
  return render(
    <MemoryRouter initialEntries={[`/settings${search}`]}>
      <Routes>
        <Route path="/settings" element={<ProvidersSection />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** 左栏行是按钮;详情头的同名标题是 span —— 按 role 取到的只会是那一行。 */
function cursorRow() {
  return screen.getByRole('button', { name: 'settings.providers.cursor.title' });
}

beforeEach(() => {
  // 装没装是模块级缓存(启动预热 + 单飞行),不清会把上一条用例的结果带进下一条,
  // 后面改 cursorState.installed 全部失效。
  cursorAvailabilityTesting.reset();
  cursorState.installed = false;
  cursorState.auth = { authenticated: false };
  providersState.providers = [
    makeProvider('anthropic', { name: 'Anthropic', connected: true }),
  ];
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    platform: 'darwin',
    openExternal: vi.fn(),
    maker: {
      scanLocalCli: vi.fn(async () => ({ detections: [] })),
      requestProviderModelsAutoRefresh: vi.fn(async () => ({ ok: true })),
      agent: {
        getCursorBinaryStatus: vi.fn(async () => ({ installed: cursorState.installed })),
        installCursorAgent: vi.fn(async () => ({ installed: true })),
      },
      auth: {
        getState: vi.fn(async () => cursorState.auth),
        triggerLogin: vi.fn(async () => cursorState.auth),
        cancelLogin: vi.fn(),
        logout: vi.fn(async () => undefined),
        onStateChanged: vi.fn(() => () => undefined),
        onLoginProgress: vi.fn(() => () => undefined),
      },
    },
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ProvidersSection — Cursor 伪行', () => {
  it('未安装也出现左栏行;未选中时右栏仍是真实供应商,页面无底部独立卡片', async () => {
    renderAt();

    expect(await screen.findByText('settings.providers.anthropic.title')).not.toBeNull();
    expect(cursorRow()).not.toBeNull();
    // 详情正文只在右栏出现:底部大卡片若还在,这段文案会与供应商详情同时存在。
    expect(screen.queryByText('settings.providers.cursor.missingDescription')).toBeNull();
  });

  it('选中 Cursor 行 → 右栏为安装引导,真实供应商详情让位', async () => {
    renderAt();
    fireEvent.click(await screen.findByRole('button', { name: 'settings.providers.cursor.title' }));

    expect(
      await screen.findByText('settings.providers.cursor.missingDescription'),
    ).not.toBeNull();
    expect(
      screen.getByRole('button', { name: 'settings.providers.cursor.installCta' }),
    ).not.toBeNull();
    expect(screen.queryByText('settings.providers.anthropic.title')).toBeNull();
  });

  it('已安装已登录 → 右栏给登出入口,且没有供应商级停用/刷新动作', async () => {
    cursorState.installed = true;
    cursorState.auth = { authenticated: true, identity: 'dev@example.test' };
    renderAt();
    fireEvent.click(await screen.findByRole('button', { name: 'settings.providers.cursor.title' }));

    expect(
      await screen.findByRole('button', { name: 'settings.providers.cursor.logoutCta' }),
    ).not.toBeNull();
    // Cursor 不是可路由供应商:不给停用菜单,也不给「刷新内置模型」。
    expect(screen.queryByLabelText('settings.providers.detail.moreActionsAria')).toBeNull();
    expect(screen.queryByLabelText('settings.providers.models.refreshBuiltinAria')).toBeNull();
  });

  it('connect=cursor 深链直接选中伪行,不开向导', async () => {
    renderAt('?tab=providers&connect=cursor');

    await waitFor(() =>
      expect(screen.getByText('settings.providers.cursor.missingDescription')).not.toBeNull(),
    );
    expect(screen.queryByTestId('wizard-stub')).toBeNull();
  });
});
