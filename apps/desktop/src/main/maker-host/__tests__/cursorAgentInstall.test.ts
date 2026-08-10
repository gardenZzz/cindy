/**
 * cursor-agent 官方安装入口单测 —— 不跑真实 curl；校验平台门禁与命令注入点。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  CURSOR_AGENT_INSTALL_COMMAND,
  CURSOR_AGENT_INSTALL_URL,
  isCursorAgentInstallSupported,
  runCursorAgentInstall,
} from '../cursor-agent-install.js';

describe('cursor-agent-install', () => {
  it('安装 URL / 展示命令与官方口径一致', () => {
    expect(CURSOR_AGENT_INSTALL_URL).toBe('https://cursor.com/install');
    expect(CURSOR_AGENT_INSTALL_COMMAND).toBe(
      'curl -fsSL https://cursor.com/install | bash',
    );
  });

  it('仅 darwin / linux 支持官方安装', () => {
    expect(isCursorAgentInstallSupported('darwin')).toBe(true);
    expect(isCursorAgentInstallSupported('linux')).toBe(true);
    expect(isCursorAgentInstallSupported('win32')).toBe(false);
  });

  it('支持平台才调用 runCommand，且传入官方命令', async () => {
    const runCommand = vi.fn(async () => undefined);
    await runCursorAgentInstall({ platform: 'darwin', runCommand });
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand).toHaveBeenCalledWith(CURSOR_AGENT_INSTALL_COMMAND);
  });

  it('win32 在调用 runCommand 前即拒绝', async () => {
    const runCommand = vi.fn(async () => undefined);
    await expect(
      runCursorAgentInstall({ platform: 'win32', runCommand }),
    ).rejects.toThrow(/does not support win32/);
    expect(runCommand).not.toHaveBeenCalled();
  });
});
