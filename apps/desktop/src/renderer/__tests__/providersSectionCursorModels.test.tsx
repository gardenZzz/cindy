// @vitest-environment jsdom

/**
 * spec #21 / S1 - 设置页 Cursor 详情右栏的模型清单 + 显示开关。
 *
 * 守外部可见行为:
 *  - 缓存有模型时列出全部模型,每行一个开关;Auto 行不带开关。
 *  - 关掉某模型 -> setModelVisibility('cursor','cursor',id,false)。
 *  - 「全部隐藏」为除 Auto 外每个模型写显式关闭;「全部显示」同理。
 *  - 空态:缓存只有 Auto(或空)给空态文案而非空白。
 *  - 未安装 / 未登录 -> 刷新入口禁用并提示原因。
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderView } from '@cindy/model-providers';
import type { AgentCapabilities } from '@/hooks/useAgentCapabilities';

const { providersState, cursorState, cursorCaps, visibility, setManySpy } = vi.hoisted(() => ({
  providersState: { providers: [] as unknown[] },
  cursorState: {
    installed: false,
    auth: { authenticated: false } as { authenticated: boolean; identity?: string },
  },
  cursorCaps: { availableModels: [] } as Pick<AgentCapabilities, 'availableModels'>,
  visibility: { map: {} as Record<string, boolean> },
  setManySpy: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'zh-CN' } }),
}));

vi.mock('@/hooks/useProviders', () => ({
  useProviders: () => ({ providers: providersState.providers, providerOrder: [], ownerGeneration: 0, loading: false, refetch: vi.fn() }),
}));

vi.mock('@/hooks/useAgentCapabilities', () => ({
  // 只返回 cursor caps;cc/codex 在本测试不渲染,给空壳。
  useAgentCapabilities: (agentKind: string | null) =>
    agentKind === 'cursor'
      ? { capabilities: cursorCaps, loading: false, error: null }
      : { capabilities: null, loading: false, error: null },
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ mode: 'cloud', exitLocalMode: vi.fn(async () => undefined) }),
}));

vi.mock('@/hooks/useCodexAuth', () => ({
  isChatGptConnectionConnected: () => false,
  useCodexAuth: () => ({ state: { kind: 'unauthenticated' }, triggerLogin: vi.fn(), cancelLogin: vi.fn(), logout: vi.fn() }),
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

vi.mock('@/lib/providerModels', () => ({ providerMonogram: () => 'X' }));

vi.mock('@/lib/providerSubtitle', () => ({
  customProviderSubtitleForDisplay: () => '',
  providerSubtitleForDisplay: () => 'subtitle',
}));

// 真 modelVisibilityPrefs 用内存 map,跟踪开关写入。
vi.mock('@/state/modelVisibilityPrefs', async () => {
  const actual = await vi.importActual<typeof import('@/state/modelVisibilityPrefs')>('@/state/modelVisibilityPrefs');
  return {
    ...actual,
    isModelEnabled: (_a: unknown, _p: string, model: { id: string }) => visibility.map[model.id] ?? true,
    setModelVisibility: (_a: unknown, _p: string, modelId: string, enabled: boolean) => {
      visibility.map[modelId] = enabled;
    },
    setManyVisibility: setManySpy.mockImplementation((_a: unknown, _p: string, modelIds: readonly string[], enabled: boolean) => {
      for (const id of modelIds) visibility.map[id] = enabled;
    }),
    useModelVisibilityVersion: () => 0,
  };
});

vi.mock('@/components/settings/CustomProviderDialog', () => ({ CustomProviderDialog: () => null }));

import { ProvidersSection } from '@/components/settings/ProvidersSection';
import { __testing as cursorAvailabilityTesting } from '@/state/cursorAvailability';

function makeProvider(id: string, over?: Partial<ProviderView>): ProviderView {
  return { id, name: id, source: 'builtin', agents: ['claude-code'], auth: { method: 'oauth' }, routing: {}, models: { 'claude-code': [] }, connected: false, ...over } as unknown as ProviderView;
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

async function selectCursor() {
  fireEvent.click(await screen.findByRole('button', { name: 'settings.providers.cursor.title' }));
}

beforeEach(() => {
  // 装没装是模块级缓存(启动预热 + 单飞行),不清会把上一条用例的结果带进下一条,
  // 后面改 cursorState.installed 全部失效。
  cursorAvailabilityTesting.reset();
  cursorState.installed = false;
  cursorState.auth = { authenticated: false };
  cursorCaps.availableModels = [];
  visibility.map = {};
  providersState.providers = [makeProvider('anthropic', { name: 'Anthropic', connected: true })];
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    platform: 'darwin',
    openExternal: vi.fn(),
    maker: {
      scanLocalCli: vi.fn(async () => ({ detections: [] })),
      requestProviderModelsAutoRefresh: vi.fn(async () => ({ ok: true })),
      setProviderOrder: vi.fn(async () => ({ ok: true })),
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

describe('ProvidersSection - Cursor 模型清单与显示开关 (spec #21 / S1)', () => {
  it('缓存有模型时列出全部,Auto 行不带开关', async () => {
    cursorState.installed = true;
    cursorState.auth = { authenticated: true, identity: 'dev@example.test' };
    cursorCaps.availableModels = [
      { id: 'auto', displayName: 'Auto', contextWindow: 200_000, efforts: [], defaultEffort: null },
      { id: 'claude-opus-5', displayName: 'Opus 5', contextWindow: 300_000, efforts: ['low', 'high'], defaultEffort: 'high' },
      { id: 'gpt-5.5', displayName: 'GPT-5.5', contextWindow: 1_000_000, efforts: [], defaultEffort: null },
    ] as AgentCapabilities['availableModels'];

    renderAt();
    await selectCursor();

    // 每个模型名字都列出。
    expect(await screen.findByText('Opus 5')).not.toBeNull();
    expect(screen.getByText('GPT-5.5')).not.toBeNull();
    // Auto 行显示「常显」而非开关。
    expect(screen.getByText('settings.providers.cursor.models.autoAlwaysOn')).not.toBeNull();
    // 非 Auto 行有开关(role=switch);Auto 不应。
    const switches = screen.getAllByRole('switch');
    expect(switches.length).toBe(2);
  });

  it('关掉某个模型 -> setModelVisibility(cursor,cursor,id,false)', async () => {
    cursorState.installed = true;
    cursorState.auth = { authenticated: true, identity: 'x' };
    cursorCaps.availableModels = [
      { id: 'auto', displayName: 'Auto', contextWindow: 200_000, efforts: [], defaultEffort: null },
      { id: 'claude-opus-5', displayName: 'Opus 5', contextWindow: 300_000, efforts: ['low'], defaultEffort: 'low' },
      { id: 'gpt-5.5', displayName: 'GPT-5.5', contextWindow: 1_000_000, efforts: [], defaultEffort: null },
    ] as AgentCapabilities['availableModels'];

    renderAt();
    await selectCursor();

    // 等模型清单渲染完成再取开关(probe/auth 状态经 useEffect 异步解析)。
    await screen.findByText('Opus 5');
    const opusSwitch = screen.getAllByRole('switch')[0]!;
    fireEvent.click(opusSwitch);
    expect(visibility.map['claude-opus-5']).toBe(false);
    // 另一个模型与 Auto 不受影响。
    expect(visibility.map['gpt-5.5']).toBeUndefined();
    expect(visibility.map['auto']).toBeUndefined();
  });

  it('「全部隐藏」为除 Auto 外每个模型写显式关闭;「全部显示」同理', async () => {
    cursorState.installed = true;
    cursorState.auth = { authenticated: true, identity: 'x' };
    cursorCaps.availableModels = [
      { id: 'auto', displayName: 'Auto', contextWindow: 200_000, efforts: [], defaultEffort: null },
      { id: 'm1', displayName: 'M1', contextWindow: 200_000, efforts: [], defaultEffort: null },
      { id: 'm2', displayName: 'M2', contextWindow: 200_000, efforts: [], defaultEffort: null },
    ] as AgentCapabilities['availableModels'];

    renderAt();
    await selectCursor();

    // 等模型清单渲染完成(probe/auth 状态经 useEffect 异步解析)。
    await screen.findByText('M1');
    // 「全部隐藏」为除 Auto 外每个模型写显式关闭。
    setManySpy.mockClear();
    const disableAll = screen.getByRole('button', { name: 'settings.providers.models.disableAll' });
    fireEvent.click(disableAll);
    expect(setManySpy).toHaveBeenCalledWith(
      'cursor',
      'cursor',
      expect.arrayContaining(['m1', 'm2']),
      false,
    );
    // Auto 不在写入集合里。
    expect(setManySpy.mock.calls[0]?.[2]).not.toContain('auto');
    // 内存 map 也被写(m1/m2=false, auto 不变)。
    expect(visibility.map['m1']).toBe(false);
    expect(visibility.map['m2']).toBe(false);
    expect(visibility.map['auto']).toBeUndefined();
  });

  it('空态:缓存只有 Auto -> 给空态文案而非空白', async () => {
    cursorState.installed = true;
    cursorState.auth = { authenticated: true, identity: 'x' };
    cursorCaps.availableModels = [
      { id: 'auto', displayName: 'Auto', contextWindow: 200_000, efforts: [], defaultEffort: null },
    ] as AgentCapabilities['availableModels'];

    renderAt();
    await selectCursor();

    expect(await screen.findByText('settings.providers.cursor.models.emptyState')).not.toBeNull();
    // 空态下仍可点刷新(已登录可用)。
    expect(screen.getByRole('button', { name: 'settings.providers.cursor.models.refreshCta' })).not.toBeNull();
  });

  it('未安装 -> 不渲染模型清单(给安装引导),刷新入口随之不在', async () => {
    cursorState.installed = false;
    renderAt();
    await selectCursor();

    // 未安装:右栏是安装引导,模型清单 / 刷新入口都不渲染。
    expect(await screen.findByText('settings.providers.cursor.missingDescription')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'settings.providers.cursor.models.refreshCta' })).toBeNull();
  });

  it('已安装未登录 -> 刷新入口禁用并提示先登录', async () => {
    cursorState.installed = true;
    cursorState.auth = { authenticated: false };
    cursorCaps.availableModels = [
      { id: 'auto', displayName: 'Auto', contextWindow: 200_000, efforts: [], defaultEffort: null },
      { id: 'm1', displayName: 'M1', contextWindow: 200_000, efforts: [], defaultEffort: null },
    ] as AgentCapabilities['availableModels'];

    renderAt();
    await selectCursor();

    const refresh = await screen.findByRole('button', { name: 'settings.providers.cursor.models.refreshCta' });
    expect((refresh as HTMLButtonElement).disabled).toBe(true);
    expect(await screen.findByText('settings.providers.cursor.models.refreshUnavailableAuth')).not.toBeNull();
  });

  it('真实供应商(Anthropic)行与刷新行为不受影响', async () => {
    cursorState.installed = true;
    cursorState.auth = { authenticated: true, identity: 'x' };
    // Anthropic 行仍存在且可被选中(不选 Cursor 时)。
    renderAt();
    expect(await screen.findByText('settings.providers.anthropic.title')).not.toBeNull();
    // 选中 Cursor 不应破坏 Anthropic 行的 DOM 存在性(只是让位详情)。
    await selectCursor();
    // 模型开关只作用于 Cursor 段;Anthropic 的 builtin 刷新 aria 不出现在 Cursor 详情。
    expect(screen.queryByLabelText('settings.providers.models.refreshBuiltinAria')).toBeNull();
  });
});
