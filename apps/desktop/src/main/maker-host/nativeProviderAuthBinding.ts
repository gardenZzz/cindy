import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import { getActiveAppSession, isAppSessionBoundaryPending } from '../appSessionState.js';

type NativeProviderId = 'anthropic' | 'openai' | 'xai';
type BindingFile = Partial<Record<NativeProviderId, string>> & {
  legacyClaimOwner?: string;
  /**
   * 被**显式登出**过、且尚未重新授权的 provider（值 = 执行登出的 owner，仅供诊断）。
   *
   * 登出会先删凭证再解绑，但删除是 best-effort 的（Anthropic 的文件删除吞 ENOENT 之外的
   * 错误、`logoutGrok` 忽略 secret store 的失败返回）。删除失败时 slot 已空、凭证却还在，
   * 自动认领会立刻把它绑回来——等于悄悄撤销用户刚做的登出。
   *
   * 判定**不比对 owner**：标记说的是「这份残留凭证已被弃用」，而凭证存在共享的系统
   * keychain / CLI 里，换个账号它也还是登出那个账号的凭证——按 owner 比对等于给下一个
   * 账号开了继承别人凭证的口子（PR #548 review）。解除只有一条路：用户再次显式授权
   * （`bindNativeProviderAuth` 清除），那时凭证已由本人重新写入。
   */
  revoked?: Partial<Record<NativeProviderId, string>>;
};

function bindingPath(): string {
  return path.join(app.getPath('userData'), 'native-provider-auth.json');
}

function readBindings(): BindingFile {
  try {
    const value = JSON.parse(fs.readFileSync(bindingPath(), 'utf8')) as unknown;
    return value && typeof value === 'object' ? (value as BindingFile) : {};
  } catch {
    return {};
  }
}

function writeBindings(value: BindingFile): void {
  const file = bindingPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Return true only when the native OAuth credential is explicitly bound to this owner. */
export function isNativeProviderAuthBound(provider: NativeProviderId): boolean {
  const owner = getActiveAppSession().dataOwnerId;
  // During unit/bootstrap code paths there may be no committed owner yet.
  // Owner-bound sessions are fail-closed; pre-session callers retain legacy
  // behavior until authentication commits an owner boundary.
  if (!owner) return true;
  return readBindings()[provider] === owner;
}

/** Bind newly completed native OAuth to the current data owner. */
export function bindNativeProviderAuth(provider: NativeProviderId): void {
  const owner = getActiveAppSession().dataOwnerId;
  if (!owner) throw new Error('cannot bind native provider auth without an active data owner');
  const bindings = readBindings();
  // 显式授权 = 用户重新表达了「我要连它」，撤销标记就此作废。
  if (bindings.revoked && provider in bindings.revoked) {
    const revoked = { ...bindings.revoked };
    delete revoked[provider];
    bindings.revoked = revoked;
  }
  writeBindings({ ...bindings, [provider]: owner });
}

/**
 * Remove the current owner binding after logout/invalidation.
 *
 * `revoked: true` 只用于**用户显式登出**：它会留下一个持久标记，挡住后续的自动认领。
 * 服务端作废凭证（401 invalidate）不传——那不是用户意图，凭证也已被清掉，用户之后在本机
 * CLI 重新登录时仍应享有设计内的自动继承。
 */
export function unbindNativeProviderAuth(
  provider: NativeProviderId,
  opts?: { revoked?: boolean },
): void {
  const bindings = readBindings();
  const owner = getActiveAppSession().dataOwnerId;
  const marking = opts?.revoked === true && !!owner;
  if (!(provider in bindings) && !marking) return;
  delete bindings[provider];
  if (marking) bindings.revoked = { ...(bindings.revoked ?? {}), [provider]: owner as string };
  writeBindings(bindings);
}

/**
 * Claim pre-binding native OAuth credentials for the first verified cloud
 * owner. The durable marker prevents a later account from inheriting a
 * credential that was left in a shared CLI/keychain store after logout.
 */
export function migrateLegacyNativeProviderAuthBindings(
  ownerId: string,
  available: Partial<Record<NativeProviderId, boolean>>,
): void {
  const bindings = readBindings();
  if (bindings.legacyClaimOwner) return;

  const next: BindingFile = { ...bindings, legacyClaimOwner: ownerId };
  for (const provider of ['anthropic', 'openai', 'xai'] as const) {
    // 显式登出过的 provider 一律跳过:这条一次性迁移同样不能把用户弃用掉的残留凭证
    // 认领回来(PR #548 review)。
    if (bindings.revoked && provider in bindings.revoked) continue;
    if (available[provider] && !next[provider]) next[provider] = ownerId;
  }
  writeBindings(next);
}

/**
 * Claim an auto-detected local CLI credential for the current owner.
 *
 * Applies to every native provider, not just Codex. Two independent holes make
 * the intended first-owner auto-connect strand forever without this repair:
 *   - the one-shot legacy migration above can consume `legacyClaimOwner` while a
 *     credential is not visible yet (the Codex ~/.codex reconcile hardlink is
 *     created after startup, so its probe reads false);
 *   - the migration only runs for cloud owners that hold the legacy namespace
 *     claim, so local-mode owners — and cloud owners whose claim marker is
 *     absent — never get a chance to inherit at all, no matter how visible the
 *     credential is. Anthropic and xAI read their credential synchronously and
 *     are therefore immune to the first hole but not to the second.
 *
 * This repairs exactly that: only when the slot has no owner, the credential
 * exists, and no OTHER account won the legacy claim. An existing binding is
 * never overwritten, so account switches stay fail-closed like
 * migrateLegacyNativeProviderAuthBindings.
 */
export function claimDetectedNativeProviderAuth(
  provider: NativeProviderId,
  hasCredential: () => boolean,
): boolean {
  const owner = getActiveAppSession().dataOwnerId;
  if (!owner) return false;
  // A session boundary in flight means `owner` is about to be replaced: writing
  // now would hand the outgoing account's credential to the incoming one.
  // Callers reached from an async settle (Codex reconcile) additionally pin an
  // owner+generation snapshot; this guard is the floor every caller gets.
  if (isAppSessionBoundaryPending()) return false;
  const bindings = readBindings();
  // Key-presence, not truthiness: a corrupted/empty-string slot must count as
  // "claimed by unknown" and fail closed, never as re-claimable (matches
  // unbindNativeProviderAuth's `in` pattern).
  if (provider in bindings) return false;
  if ('legacyClaimOwner' in bindings && bindings.legacyClaimOwner !== owner) return false;
  // 被显式登出过就绝不自动认领,且**不比对 owner**:凭证在共享的系统 keychain / CLI 里,
  // 换个账号它仍是登出那个账号的凭证 —— 按 owner 比对等于给下一个账号开了继承别人凭证
  // 的口子。解除只有「用户再次显式授权」一条路(PR #548 review)。
  if (bindings.revoked && provider in bindings.revoked) return false;
  if (!hasCredential()) return false;
  writeBindings({ ...bindings, [provider]: owner });
  return true;
}
