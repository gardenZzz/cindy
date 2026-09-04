// @vitest-environment jsdom

/**
 * SshKeySetupDialog 「解锁」弹窗的关键不变量:**没有 passphrase 的私钥也必须能进
 * ssh-agent**。提交按钮之前是 `disabled={!pass || submitting}`,而未加密的密钥正确
 * 输入就是「什么都不填」——于是这类密钥在界面上没有任何路径能加载到 agent。
 *
 * main 侧 `addKeyToAgent` 本来就有 no-passphrase 分支(跳过 SSH_ASKPASS,直接
 * 跑 `ssh-add`),卡住的只有 UI。这条用例锁住空 passphrase 可提交,并且原样透传
 * 空串给 IPC。
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `t` 必须是稳定引用:组件里 refreshKeys = useCallback(..., [t]),而拉密钥列表的
// effect 依赖 refreshKeys。每次 render 新建 t 会让该 effect 每帧重跑 → setState →
// 无限循环("Maximum update depth exceeded")。
const { t } = vi.hoisted(() => ({ t: (key: string) => key }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t, i18n: { language: 'zh-CN' } }),
}));

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { SshKeySetupDialog } from '@/components/settings/SshKeySetupDialog';

const unencryptedKey: LocalSshKeyInfo = {
  privateKeyPath: '/home/dev/.ssh/id_rsa',
  pubkeyPath: '/home/dev/.ssh/id_rsa.pub',
  type: 'rsa',
  comment: 'dev@example.com',
  fingerprintSha256: 'SHA256:HKfN1yQ3hZLmLrqTfake0000000000000000000000',
  inAgent: false,
  mtimeIso: null,
};

const listLocalKeys = vi.fn(async () => ({ keys: [unencryptedKey] }));
const addKeyToAgent = vi.fn(async () => ({
  result: { success: true, failureReason: null, errorHint: null, stderr: '' },
}));

beforeEach(() => {
  listLocalKeys.mockClear();
  addKeyToAgent.mockClear();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    remoteSsh: { listLocalKeys, addKeyToAgent },
  };
});

afterEach(() => {
  cleanup();
});

describe('SshKeySetupDialog — 解锁未加密密钥', () => {
  it('passphrase 留空时提交按钮可用,并把空串透传给 addKeyToAgent', async () => {
    render(<SshKeySetupDialog hostId={null} open onOpenChange={vi.fn()} />);

    // 密钥列表里这把 key 未在 agent 中 → 行尾出现「解锁」入口。
    fireEvent.click(await screen.findByText('settings.remote.keys.unlockButton'));

    const submit = (await screen.findByText('settings.remote.keys.unlockSubmit'))
      .closest('button');
    expect(submit).toBeTruthy();
    // 回归点:密码框为空不得禁用提交。
    expect(submit!.disabled).toBe(false);

    fireEvent.click(submit!);

    await waitFor(() => {
      expect(addKeyToAgent).toHaveBeenCalledWith({
        privateKeyPath: unencryptedKey.privateKeyPath,
        passphrase: '',
      });
    });
  });
});
