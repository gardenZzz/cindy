/**
 * isAuthFailure ↔ authFailureHint 的 invariant 回归。
 *
 * 背景（2026-07 cindy_ssh PR review 发现）：connect() 失败时会把 ssh2 原始
 * auth 错误改写成 authFailureHint 的友好文案再 reject / 存进 lastError，而
 * 后续所有"是否认证失败"的判定（RemoteHost 自身的 reconnect 跳过、desktop
 * ensureRemoteHostReady 的 IPC 错误码分类、cindy_ssh 工具错误码）都跑在改写
 * 后的字符串上。若 isAuthFailure 不识别自家 hint 文案，确定性的认证失败会
 * 被降级成"可重试的连接失败"，引发无意义重连/重试。
 *
 * 因此硬性 invariant：authFailureHint 的每一种输出都必须让 isAuthFailure
 * 返回 true。改 hint 措辞时本测试会红，提醒同步 isAuthFailure 的关键词表。
 */

import { describe, it, expect } from 'vitest';

import { isAuthFailure, authFailureHint } from '../RemoteHost.js';
import type { HostConfig } from '../types.js';

function cfg(partial: Partial<HostConfig>): HostConfig {
  return {
    id: 'web-1',
    hostname: '10.0.0.5',
    port: 22,
    user: 'deploy',
    authMethod: 'agent',
    source: 'manual',
    managedByCindy: false,
    ...partial,
  };
}

describe('isAuthFailure recognizes every authFailureHint variant', () => {
  it('agent mode hint', () => {
    expect(isAuthFailure(authFailureHint(cfg({ authMethod: 'agent' })))).toBe(true);
  });

  it('agent mode hint with non-default port', () => {
    expect(isAuthFailure(authFailureHint(cfg({ authMethod: 'agent', port: 2222 })))).toBe(true);
  });

  it('pinned agent hint tells the user to load the matching key', () => {
    const hint = authFailureHint(cfg({
      authMethod: 'agent',
      sshAuthentication: {
        identitiesOnly: true,
        configuredIdentityFiles: ['/home/u/.ssh/id_ed25519'],
        identityFileDirectiveSeen: true,
        identityFileNoneSeen: false,
        allowedAgentFingerprints: ['SHA256:test'],
      },
    }));
    expect(hint).toContain('ssh-add');
    expect(isAuthFailure(hint)).toBe(true);
  });

  it('ssh config 写了 IdentityFile 但没 IdentitiesOnly 时也引导 ssh-add', () => {
    // 无 Cindy marker 的普通 OpenSSH host 一律 Agent-first,identityFile 与
    // allowedAgentFingerprints 都是空,只剩 configuredIdentityFiles。此时劝
    // ssh-copy-id 是错的(pubkey 通常已在远端),劝"改用 Identity file 认证"
    // 更是死路(ssh-config 来源的 host 在设置里连接字段只读)。
    const hint = authFailureHint(cfg({
      authMethod: 'agent',
      sshAuthentication: {
        identitiesOnly: false,
        configuredIdentityFiles: ['/home/u/.ssh/id_rsa'],
        identityFileDirectiveSeen: true,
        identityFileNoneSeen: false,
      },
    }));
    expect(hint).toContain('ssh-add');
    expect(hint).not.toContain('ssh-copy-id');
    expect(hint).not.toContain('Identity file');
    expect(isAuthFailure(hint)).toBe(true);
  });

  it('key mode hint (with and without identityFile)', () => {
    const hint = authFailureHint(cfg({
      authMethod: 'key',
      identityFile: '/home/u/.ssh/custom-private.key',
    }));
    expect(isAuthFailure(hint)).toBe(true);
    expect(hint).toContain('<public-key-file>');
    expect(hint).not.toContain('/home/u/.ssh');
    expect(hint).not.toContain('custom-private.key.pub');
    expect(isAuthFailure(authFailureHint(cfg({ authMethod: 'key' })))).toBe(true);
  });

  it('fallback hint', () => {
    // authMethod 越界时走兜底文案("Authentication failed connecting as ...")。
    expect(
      isAuthFailure(authFailureHint(cfg({ authMethod: 'password' as HostConfig['authMethod'] }))),
    ).toBe(true);
  });
});

describe('isAuthFailure still recognizes raw ssh2 auth errors', () => {
  it.each([
    'All configured authentication methods failed',
    'Authentication failed.',
    'auth failed',
    'Permission denied (publickey)',
    'No matching authentication scheme',
  ])('%s', (msg) => {
    expect(isAuthFailure(msg)).toBe(true);
  });

  it('does not misclassify plain connection errors', () => {
    expect(isAuthFailure('connect ETIMEDOUT 10.0.0.5:22')).toBe(false);
    expect(isAuthFailure('connection closed before ready')).toBe(false);
  });
});
