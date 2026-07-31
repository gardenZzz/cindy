/**
 * Per-Cindy-session isolated Cursor CLI config.
 *
 * 用户全局 `~/.cursor/cli-config.json` 若 `approvalMode: unrestricted`，会完全
 * 屏蔽 `session/request_permission`（issue #7 spike 实测）。Cindy 通过
 * `CURSOR_CONFIG_DIR` 指向隔离目录，写入 approvalMode=allowlist，让权限回调
 * 必达客户端策略层；**不改**用户本机 cli-config / sandbox。
 *
 * Auth 仍走 macOS Keychain 的 cursor_login（伪造 HOME 会失败；只改 CONFIG_DIR 可登录）。
 *
 * ## 生命周期契约
 *
 * 上游把 ACP 会话落在 `$CURSOR_CONFIG_DIR/acp-sessions/<id>/`，因此目录必须按
 * Cindy 业务 sessionId 稳定复用：
 *
 * - **create**：`<userData>/cursor-acp/<safe(sessionId)>/`（跨进程 resume）
 * - **agent dispose / close**：no-op —— 不得 rm（否则 session/load not found）
 * - **Cindy session status → deleted**：宿主调用 `removeCursorIsolatedConfigDir`
 *   （对齐 imageCache / media refs；archived 保留，恢复后仍可 resume）
 * - **userDataPath**：必须由宿主注入（Desktop = `app.getPath('userData')`；
 *   CLI / 单测 = `mkdtemp` 根）。maker-core **不**回落 HOME / `~/.cindy`
 *   （见 credentials-and-local-storage.md）。
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';

export interface CursorIsolatedConfig {
  configDir: string;
  /** 合并进 spawn env 的变量。 */
  env: NodeJS.ProcessEnv;
  /** close 时调用。稳定目录下为 no-op（保留 acp-sessions 供 resume）。 */
  dispose: () => void;
}

export interface CreateCursorIsolatedConfigOptions {
  /**
   * Cindy 业务 session id（非上游 sdk session id）。
   * 有值 → 稳定目录，跨进程 resume 可找到 acp-sessions。
   * 无值 → 仍写到共享 sticky 根下的 ephemeral 子目录（不删）。
   */
  stableKey?: string;
  /**
   * 宿主注入的 userData 根（Electron `app.getPath('userData')`，或测试 `mkdtemp`）。
   * **必填**——maker-core 零 Electron 依赖，也不静默写开发者 HOME。
   */
  userDataPath: string;
}

function safeDirSegment(key: string): string {
  const trimmed = key.trim();
  if (!trimmed) return 'anonymous';
  // 文件系统安全：保留可读前缀 + 短 hash，避免过长 / 特殊字符。
  const hash = createHash('sha256').update(trimmed).digest('hex').slice(0, 12);
  const prefix = trimmed.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 48);
  return `${prefix}-${hash}`;
}

function requireUserDataPath(userDataPath: string | undefined): string {
  const trimmed = typeof userDataPath === 'string' ? userDataPath.trim() : '';
  if (!trimmed) {
    throw new Error(
      'Cursor isolated config requires userDataPath (host/CLI/test must inject; no HOME fallback)',
    );
  }
  return trimmed;
}

function resolveRoot(userDataPath: string): string {
  return join(requireUserDataPath(userDataPath), 'cursor-acp');
}

/** True iff `child` is strictly inside `parent` (not equal). */
function isStrictlyInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(sep);
}

/**
 * 用户全局 cli-config 的 `network` 段。`useHttp1ForAgent` 是上游对付
 * 「h2 stream CANCEL / 反复重连」的逃生阀；隔离 config 写死会把它关死，
 * 用户在 Cursor 里打开也对 Cindy 会话无效。读不到就 undefined（用默认）。
 */
function readUserNetworkConfig(baseEnv: NodeJS.ProcessEnv): unknown {
  const dir = baseEnv.CURSOR_CONFIG_DIR?.trim() || join(homedir(), '.cursor');
  try {
    const raw = JSON.parse(readFileSync(join(dir, 'cli-config.json'), 'utf8')) as unknown;
    if (typeof raw !== 'object' || raw === null) return undefined;
    return (raw as Record<string, unknown>).network;
  } catch {
    return undefined;
  }
}

function writeIsolatedCliConfig(configDir: string, network: unknown): void {
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
    network: network ?? { useHttp1ForAgent: false },
  };
  writeFileSync(join(configDir, 'cli-config.json'), `${JSON.stringify(cliConfig, null, 2)}\n`);
}

/** Resolve the sticky config dir for a Cindy business session id. */
export function resolveCursorIsolatedConfigDir(
  userDataPath: string,
  stableKey: string,
): string {
  return join(resolveRoot(userDataPath), safeDirSegment(stableKey));
}

/**
 * 会话删除时回收隔离目录（含上游 acp-sessions）。
 * 仅删 `stableKey` 对应子目录；绝不触碰其它会话目录或 root 本身。
 * 路径若不在 cursor-acp root 内则 no-op（防路径穿越）。
 */
export function removeCursorIsolatedConfigDir(
  userDataPath: string,
  stableKey: string,
): void {
  const key = stableKey.trim();
  if (!key) return;
  const root = resolveRoot(userDataPath);
  const configDir = join(root, safeDirSegment(key));
  if (!isStrictlyInside(root, configDir)) return;
  rmSync(configDir, { recursive: true, force: true });
}

export function createCursorIsolatedConfigDir(
  baseEnv: NodeJS.ProcessEnv = process.env,
  opts: CreateCursorIsolatedConfigOptions,
): CursorIsolatedConfig {
  const root = resolveRoot(opts.userDataPath);
  mkdirSync(root, { recursive: true });
  const configDir = join(root, safeDirSegment(opts.stableKey ?? `ephemeral-${Date.now()}`));
  mkdirSync(configDir, { recursive: true });
  writeIsolatedCliConfig(configDir, readUserNetworkConfig(baseEnv));

  return {
    configDir,
    env: {
      ...baseEnv,
      CURSOR_CONFIG_DIR: configDir,
    },
    // 保留 acp-sessions 供 session/load；不在 close 路径删除。
    // 清理时机：Cindy session deleted → removeCursorIsolatedConfigDir。
    dispose: () => undefined,
  };
}
