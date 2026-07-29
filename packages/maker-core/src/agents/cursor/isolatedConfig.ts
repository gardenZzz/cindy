/**
 * Per-session isolated Cursor CLI config.
 *
 * 用户全局 `~/.cursor/cli-config.json` 若 `approvalMode: unrestricted`，会完全
 * 屏蔽 `session/request_permission`（issue #7 spike 实测）。Cindy 通过
 * `CURSOR_CONFIG_DIR` 指向临时目录，写入 approvalMode=allowlist，让权限回调
 * 必达客户端策略层；**不改**用户本机 cli-config / sandbox。
 *
 * Auth 仍走 macOS Keychain 的 cursor_login（伪造 HOME 会失败；只改 CONFIG_DIR 可登录）。
 */

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface CursorIsolatedConfig {
  configDir: string;
  /** 合并进 spawn env 的变量。 */
  env: NodeJS.ProcessEnv;
  dispose: () => void;
}

export function createCursorIsolatedConfigDir(
  baseEnv: NodeJS.ProcessEnv = process.env,
): CursorIsolatedConfig {
  const configDir = mkdtempSync(join(tmpdir(), 'cindy-cursor-acp-'));
  const cliConfig = {
    version: 1,
    permissions: { allow: [] as string[], deny: [] as string[] },
    // 强制走 allowlist，使 session/request_permission 到达 Cindy。
    approvalMode: 'allowlist',
    // 不碰用户 sandbox：临时配置仅服务 Cindy 子进程，与用户全局配置隔离。
    sandbox: {
      mode: 'disabled',
      networkAccess: 'user_config_with_defaults',
    },
    editor: { vimMode: false },
    network: { useHttp1ForAgent: false },
  };
  writeFileSync(join(configDir, 'cli-config.json'), `${JSON.stringify(cliConfig, null, 2)}\n`);

  return {
    configDir,
    env: {
      ...baseEnv,
      CURSOR_CONFIG_DIR: configDir,
    },
    dispose: () => {
      try {
        rmSync(configDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}
