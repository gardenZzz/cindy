import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const userDataDir = '/tmp/native-provider-auth-binding-test';
const session = { dataOwnerId: 'owner-a' as string | null, boundaryPending: false };

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir },
}));

vi.mock('../../appSessionState.js', () => ({
  getActiveAppSession: () => ({
    mode: session.dataOwnerId ? 'cloud' : 'signed-out',
    dataOwnerId: session.dataOwnerId,
    generation: 1,
  }),
  isAppSessionBoundaryPending: () => session.boundaryPending,
}));

import {
  bindNativeProviderAuth,
  claimDetectedNativeProviderAuth,
  isNativeProviderAuthBound,
  migrateLegacyNativeProviderAuthBindings,
  unbindNativeProviderAuth,
} from '../nativeProviderAuthBinding.js';

const bindingFile = path.join(userDataDir, 'native-provider-auth.json');

afterEach(() => {
  session.dataOwnerId = 'owner-a';
  session.boundaryPending = false;
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

describe('native provider auth legacy binding', () => {
  it('claims available legacy credentials for the first owner only', () => {
    migrateLegacyNativeProviderAuthBindings('owner-a', {
      anthropic: true,
      openai: false,
    });

    expect(isNativeProviderAuthBound('anthropic')).toBe(true);
    session.dataOwnerId = 'owner-b';
    expect(isNativeProviderAuthBound('anthropic')).toBe(false);
    expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).toMatchObject({
      anthropic: 'owner-a',
      legacyClaimOwner: 'owner-a',
    });
  });

  it('does not reclaim a legacy credential after logout', () => {
    migrateLegacyNativeProviderAuthBindings('owner-a', { xai: true });
    unbindNativeProviderAuth('xai');
    session.dataOwnerId = 'owner-b';
    migrateLegacyNativeProviderAuthBindings('owner-b', { xai: true });

    expect(isNativeProviderAuthBound('xai')).toBe(false);
  });
});

describe('claimDetectedNativeProviderAuth', () => {
  it('repairs the binding when the one-shot migration consumed the claim before the credential appeared', () => {
    // 复现主 bug:legacy 迁移在 reconcile 硬链建立之前跑掉,openai 名额以 false 被消费。
    migrateLegacyNativeProviderAuthBindings('owner-a', { openai: false });
    expect(isNativeProviderAuthBound('openai')).toBe(false);

    expect(claimDetectedNativeProviderAuth('openai', () => true)).toBe(true);
    expect(isNativeProviderAuthBound('openai')).toBe(true);
    expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).toMatchObject({
      openai: 'owner-a',
      legacyClaimOwner: 'owner-a',
    });
  });

  it('claims for the current owner when no legacy claim ever ran (local mode path)', () => {
    expect(claimDetectedNativeProviderAuth('openai', () => true)).toBe(true);
    expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).toMatchObject({ openai: 'owner-a' });
  });

  it('stays fail-closed for an account that did not win the legacy claim', () => {
    migrateLegacyNativeProviderAuthBindings('owner-a', {});
    session.dataOwnerId = 'owner-b';

    expect(claimDetectedNativeProviderAuth('openai', () => true)).toBe(false);
    expect(isNativeProviderAuthBound('openai')).toBe(false);
  });

  it('never overwrites a binding held by another owner', () => {
    migrateLegacyNativeProviderAuthBindings('owner-a', { openai: true });
    session.dataOwnerId = 'owner-b';

    expect(claimDetectedNativeProviderAuth('openai', () => true)).toBe(false);
    session.dataOwnerId = 'owner-a';
    expect(isNativeProviderAuthBound('openai')).toBe(true);
  });

  it('writes nothing without a committed owner or without a credential', () => {
    session.dataOwnerId = null;
    expect(claimDetectedNativeProviderAuth('openai', () => true)).toBe(false);

    session.dataOwnerId = 'owner-a';
    expect(claimDetectedNativeProviderAuth('openai', () => false)).toBe(false);
    expect(fs.existsSync(bindingFile)).toBe(false);
  });

  it('writes nothing while a session boundary is in flight', () => {
    // owner 正在被换掉:此刻写入等于把上一个账号的凭证交给下一个账号。
    session.boundaryPending = true;
    expect(claimDetectedNativeProviderAuth('anthropic', () => true)).toBe(false);
    expect(fs.existsSync(bindingFile)).toBe(false);

    session.boundaryPending = false;
    expect(claimDetectedNativeProviderAuth('anthropic', () => true)).toBe(true);
  });

  it('claims anthropic and xai on the same terms as openai', () => {
    // 三家 native provider 共用一套认领口径:凭证在场 + 名额未被占 → 绑给当前 owner。
    expect(claimDetectedNativeProviderAuth('anthropic', () => true)).toBe(true);
    expect(claimDetectedNativeProviderAuth('xai', () => true)).toBe(true);
    expect(isNativeProviderAuthBound('anthropic')).toBe(true);
    expect(isNativeProviderAuthBound('xai')).toBe(true);

    session.dataOwnerId = 'owner-b';
    expect(isNativeProviderAuthBound('anthropic')).toBe(false);
    expect(claimDetectedNativeProviderAuth('anthropic', () => true)).toBe(false);
  });

  it('显式登出留下的撤销标记挡住自动认领(凭证删除失败也不会被绑回来)', () => {
    // 登出会先删凭证再解绑,但删除是 best-effort 的;删失败时 slot 已空、凭证还在,
    // 没有标记就会在下一次读连接态时被认领回来,等于悄悄撤销用户刚做的登出。
    expect(claimDetectedNativeProviderAuth('anthropic', () => true)).toBe(true);
    unbindNativeProviderAuth('anthropic', { revoked: true });

    expect(isNativeProviderAuthBound('anthropic')).toBe(false);
    expect(claimDetectedNativeProviderAuth('anthropic', () => true)).toBe(false);
    expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).toMatchObject({
      revoked: { anthropic: 'owner-a' },
    });
  });

  it('撤销标记只挡当前 owner;换账号后新 owner 仍可继承', () => {
    unbindNativeProviderAuth('anthropic', { revoked: true });
    expect(claimDetectedNativeProviderAuth('anthropic', () => true)).toBe(false);

    session.dataOwnerId = 'owner-b';
    expect(claimDetectedNativeProviderAuth('anthropic', () => true)).toBe(true);
  });

  it('用户再次显式授权即清除撤销标记,恢复自动继承语义', () => {
    unbindNativeProviderAuth('xai', { revoked: true });
    expect(claimDetectedNativeProviderAuth('xai', () => true)).toBe(false);

    bindNativeProviderAuth('xai');
    expect(isNativeProviderAuthBound('xai')).toBe(true);
    unbindNativeProviderAuth('xai');
    // 上一次的撤销标记已随显式授权作废,这次(非显式登出)不该再挡。
    expect(claimDetectedNativeProviderAuth('xai', () => true)).toBe(true);
  });

  it('凭证失效(非用户登出)不留标记 —— 本机重新登录后仍按设计自动继承', () => {
    expect(claimDetectedNativeProviderAuth('anthropic', () => true)).toBe(true);
    unbindNativeProviderAuth('anthropic'); // invalidate 路径:不传 revoked

    expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).not.toHaveProperty('revoked');
    expect(claimDetectedNativeProviderAuth('anthropic', () => true)).toBe(true);
  });

  it('treats corrupted falsy slot values as claimed-by-unknown and fails closed', () => {
    // 键存在但值为假(损坏 / 异常写入):按「归属不明」拒绝,绝不重认领。
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(bindingFile, JSON.stringify({ openai: '' }));
    expect(claimDetectedNativeProviderAuth('openai', () => true)).toBe(false);

    fs.writeFileSync(bindingFile, JSON.stringify({ legacyClaimOwner: '' }));
    expect(claimDetectedNativeProviderAuth('openai', () => true)).toBe(false);
    expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).toEqual({ legacyClaimOwner: '' });
  });
});
