/**
 * addKeyToAgent — 私钥路径不存在时稳定归类为 no_such_file (#1837);
 * 以及空 passphrase 必须仍然经由 SSH_ASKPASS 调用 ssh-add。
 * 缺失路径分支不会真跑 ssh-add,覆盖 Windows 路径形态。
 */

import fsp from 'node:fs/promises';
import os from 'node:os';
import nodePath from 'node:path';

import { describe, expect, it, vi, afterEach } from 'vitest';

// mock execFile 以便断言"缺失路径时 ssh-add 不会被调用"(copilot review 指出的
// 测试意图与覆盖不一致问题)。ssh-keys.ts 用 promisify(execFile) 封装,只能在
// 模块加载前 mock node:child_process。
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

import { addKeyToAgent } from '../ssh-keys.js';

afterEach(() => {
  execFileMock.mockClear();
});

describe('addKeyToAgent — missing private key path', () => {
  // 注意:不含 UNC 路径——fs.access 对 `\\nas\...` 会真实解析网络主机,测试环境
  // 可能慢/挂起。UNC 的纯字符串形态由 maker-remote-ssh 的 expandHome 单测覆盖。
  it.each([
    ['windows-drive', String.raw`C:\Users\someone\.ssh\id_ed25519`],
    ['with-space', String.raw`C:\Users\my name\Documents\ssh keys\id_ed25519`],
    ['chinese', String.raw`D:\密钥\我的密钥\id_ed25519`],
  ])('%s', async (_label, path) => {
    const result = await addKeyToAgent({ privateKeyPath: path });
    expect(result.success).toBe(false);
    expect(result.failureReason).toBe('no_such_file');
    // 真实路径必须出现在 hint 里,UI 才能显示"是哪个路径找不到"。
    expect(result.errorHint).toContain(path);
    expect(result.errorHint).toContain('not found');
  });

  it('classifies a missing path as no_such_file even with a passphrase', async () => {
    // 带 passphrase 走 SSH_ASKPASS 分支;缺失文件同样应在 ssh-add 之前被拦截。
    const missing = String.raw`C:\Users\someone\.ssh\id_ed25519`;
    const result = await addKeyToAgent({ privateKeyPath: missing, passphrase: 'secret' });
    expect(result.success).toBe(false);
    expect(result.failureReason).toBe('no_such_file');
    expect(result.errorHint).toContain(missing);
  });

  it('does not spawn ssh-add for a missing file (pre-check short-circuits)', async () => {
    const missing = String.raw`C:\Users\someone\.ssh\id_ed25519`;
    const result = await addKeyToAgent({ privateKeyPath: missing });
    expect(result.success).toBe(false);
    expect(result.failureReason).toBe('no_such_file');
    // 关键断言:缺失路径在 fs.access 就返回,execFile(ssh-add) 不被调用。
    expect(execFileMock).not.toHaveBeenCalled();
  });
});

describe('addKeyToAgent — 空 passphrase', () => {
  it('仍走 SSH_ASKPASS,不落回裸 ssh-add(那条路会挂死在 stdin 上)', async () => {
    // 未加密的私钥正确的输入就是「不填」。曾经这里会跳过 askpass 直接 execFile,
    // 对未加密密钥没问题,但同一分支也是「加密密钥 + 留空」的落点:ssh-add 找不到
    // askpass 又没有 tty,退回从 stdin 读 prompt,而 execFile 的 stdin 管道永不关闭
    // → 整个 IPC 调用无限期挂起。走 askpass 则会在几秒内被拒绝并退出。
    const dir = await fsp.mkdtemp(nodePath.join(os.tmpdir(), 'sshkeys-askpass-'));
    const keyPath = nodePath.join(dir, 'id_ed25519');
    await fsp.writeFile(keyPath, 'placeholder — ssh-add 已被 mock,不会真的解析它');
    execFileMock.mockImplementation(
      (_file: string, _args: string[], _options: unknown, cb: (e: unknown, o: string, s: string) => void) => {
        cb(null, '', '');
      },
    );
    try {
      const result = await addKeyToAgent({ privateKeyPath: keyPath });
      expect(result.success).toBe(true);
      expect(execFileMock).toHaveBeenCalledTimes(1);
      const options = execFileMock.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv } | undefined;
      expect(options?.env?.SSH_ASKPASS).toBeTruthy();
      expect(options?.env?.SSH_ASKPASS_REQUIRE).toBe('force');
    } finally {
      execFileMock.mockReset();
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});
