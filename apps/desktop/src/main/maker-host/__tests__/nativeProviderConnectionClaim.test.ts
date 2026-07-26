/**
 * 连接态读取路径上的 native provider 绑定自愈(anthropic / xai)。
 *
 * 回归的是 #294 同族缺陷的另一半:本机 CLI 凭证的自动继承只在「cloud 模式 + 持有
 * legacy 命名空间认领」时才由一次性迁移建立,local 模式 owner 与没跑到迁移的 cloud
 * owner 永远拿不到 —— 设置页与聊天门禁于是各说各话。anthropic 还多一层:清单唯一
 * 来源是动态发现,绑定建立后不补拉一次就会停在「已连接 + 零模型」。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  userDataDir: '',
  dataOwnerId: 'owner-a' as string | null,
  claudeCredentialPresent: true,
  grokCredentialPresent: true,
  refreshAnthropicModels: vi.fn(),
  loadAnthropicDiskCache: vi.fn(async () => {}),
  anthropicDiscoveryFailure: null as {
    kind: string;
    at: string;
    detail?: string;
  } | null,
}));

vi.mock('electron', () => ({
  app: { getPath: () => h.userDataDir },
  net: { request: vi.fn() },
}));

vi.mock('../../appSessionState.js', () => ({
  getActiveAppSession: () => ({
    mode: h.dataOwnerId ? ('local' as const) : ('signed-out' as const),
    dataOwnerId: h.dataOwnerId,
    generation: 1,
  }),
  isAppSessionBoundaryPending: () => false,
}));

// 本机凭证库:*Unbound 是「blob 里有凭证吗」,无绑定语义;带绑定的读取叠加 owner 校验,
// 与真实实现(readClaudeAiOAuth / hasGrokOAuthLogin)的分层一致。
vi.mock('../claude-credentials-store.js', () => ({
  hasClaudeAiOAuthUnbound: () => h.claudeCredentialPresent,
  hasClaudeAiOAuth: () =>
    h.claudeCredentialPresent && isBoundToCurrentOwner('anthropic'),
}));
vi.mock('../grok-oauth-login.js', () => ({
  hasGrokOAuthLoginUnbound: () => h.grokCredentialPresent,
  hasGrokOAuthLogin: () => h.grokCredentialPresent && isBoundToCurrentOwner('xai'),
  getGrokAccessToken: () => null,
  resetGrokOAuthMemoryCache: () => {},
}));

vi.mock('../model-discovery/anthropic.js', () => ({
  loadAnthropicModelsFromDiskCache: h.loadAnthropicDiskCache,
  refreshAnthropicModelsFromHttp: h.refreshAnthropicModels,
  getAnthropicModelDiscoveryFailure: () => h.anthropicDiscoveryFailure,
}));

vi.mock('../auth-adapters.js', () => ({
  readClaudeApiKey: () => null,
  desktopCodexAuthAdapter: { hasCodexOAuthLogin: () => false, hasCodexOAuthLoginUnbound: () => false },
}));

vi.mock('../../authManager.js', () => ({ getAuthState: () => ({ mode: 'local' as const, user: null }) }));
vi.mock('../../appCapabilities.js', () => ({ getAppCapabilities: () => ({ canUseCindyGateway: false }) }));
vi.mock('../../ownerNamespaceMigration.js', () => ({ hasLegacyOwnerNamespaceClaim: () => false }));
vi.mock('../../manifestService.js', () => ({ isDev: () => true, getBaseUrl: () => 'https://example.invalid' }));
vi.mock('../../clientEndpointsService.js', () => ({ getClientEndpoint: () => 'https://example.invalid' }));
vi.mock('../../secrets/providerSecretStore.js', () => ({
  genericOAuthSecretIo: {},
  setProviderSecretsClearedListener: () => {},
  readCustomProviderKey: () => null,
}));

import { getDesktopProviderService } from '../createDesktopProviderService.js';
import { isNativeProviderAuthBound } from '../nativeProviderAuthBinding.js';

function isBoundToCurrentOwner(provider: 'anthropic' | 'xai'): boolean {
  return isNativeProviderAuthBound(provider);
}

async function listProviders() {
  return getDesktopProviderService().listProviders();
}

async function connectedMap(): Promise<Record<string, boolean>> {
  const providers = await listProviders();
  return Object.fromEntries(providers.map((p) => [p.id, p.connected]));
}

beforeEach(() => {
  h.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-native-conn-claim-'));
  h.dataOwnerId = 'owner-a';
  h.claudeCredentialPresent = true;
  h.grokCredentialPresent = true;
  h.anthropicDiscoveryFailure = null;
  h.refreshAnthropicModels.mockClear();
  h.loadAnthropicDiskCache.mockClear();
});

afterEach(() => {
  fs.rmSync(h.userDataDir, { recursive: true, force: true });
});

describe('native provider connection claim on read', () => {
  it('认领本机 anthropic 凭证并补拉一次清单(修「已连接 + 零模型」)', async () => {
    expect(isNativeProviderAuthBound('anthropic')).toBe(false);

    expect((await connectedMap()).anthropic).toBe(true);
    expect(isNativeProviderAuthBound('anthropic')).toBe(true);
    // 绑定刚建立 —— 启动期那次发现早被登录态 gate 掉,必须在这里补一次。
    expect(h.refreshAnthropicModels).toHaveBeenCalledTimes(1);
    // 磁盘缓存同样要补:启动期那次 load 也因未绑定而早退了。不先摆出上次成功的清单,
    // 这次 HTTP 一旦失败,明明有可用缓存用户还是零模型(PR #548 review)。
    expect(h.loadAnthropicDiskCache).toHaveBeenCalledTimes(1);

    // 已绑定后不再重复认领,也不再反复打网络。
    await connectedMap();
    expect(h.refreshAnthropicModels).toHaveBeenCalledTimes(1);
    expect(h.loadAnthropicDiskCache).toHaveBeenCalledTimes(1);
  });

  it('认领本机 xai 凭证(清单不走动态发现,不触发拉取)', async () => {
    expect((await connectedMap()).xai).toBe(true);
    expect(isNativeProviderAuthBound('xai')).toBe(true);
  });

  it('凭证不在本机时既不认领也不误报已连接', async () => {
    h.claudeCredentialPresent = false;
    h.grokCredentialPresent = false;

    const connected = await connectedMap();
    expect(connected.anthropic).toBe(false);
    expect(connected.xai).toBe(false);
    expect(isNativeProviderAuthBound('anthropic')).toBe(false);
    expect(h.refreshAnthropicModels).not.toHaveBeenCalled();
  });

  it('清单发现失败时把归因挂到 ProviderView 上(UI 据此讲明理由而非「正在发现」)', async () => {
    h.anthropicDiscoveryFailure = {
      kind: 'network',
      at: '2026-07-27T00:00:00.000Z',
      detail: 'TypeError: fetch failed (ENOTFOUND)',
    };

    const providers = await listProviders();
    const anthropic = providers.find((p) => p.id === 'anthropic');
    expect(anthropic?.connected).toBe(true);
    expect(anthropic?.modelDiscoveryFailure).toMatchObject({ kind: 'network' });
    // 没有失败态的供应商不该凭空长出这个字段。
    expect(providers.find((p) => p.id === 'xai')?.modelDiscoveryFailure).toBeUndefined();
  });

  it('凭证已属于别的 owner 时保持 fail-closed', async () => {
    fs.writeFileSync(
      path.join(h.userDataDir, 'native-provider-auth.json'),
      JSON.stringify({ anthropic: 'owner-b', legacyClaimOwner: 'owner-b' }),
    );

    const connected = await connectedMap();
    expect(connected.anthropic).toBe(false);
    expect(h.refreshAnthropicModels).not.toHaveBeenCalled();
  });
});
