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

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export interface CursorIsolatedConfig {
  configDir: string;
  /** 合并进 spawn env 的变量。 */
  env: NodeJS.ProcessEnv;
  /** close 时调用。稳定目录下为 no-op（保留 acp-sessions 供 resume）。 */
  dispose: () => void;
}

/**
 * 预写进 cli-config 的模型档位。上游把「当前模型 + 每模型参数」记在同一个
 * cli-config.json 里，预写命中后 `session/new` 直接回目标档位，省掉建会话后的
 * `set_config_option` 往返（实测单次 ~3s）。
 *
 * 不写推理强度：它的 configOption id 因模型家族而异（`effort` / `reasoning`），
 * 猜错或两个都写会让上游整条参数回落成默认值（实测 grok-4.5 回落 low）。留给
 * 合并写保住的上游自有记录 + 会话内比对补发。
 */
export interface CursorModelSeed {
  /** ACP model id（`auto` 需先经 toCursorAcpModelId 映射成 `default`）。 */
  modelId: string;
  /** configOption id → 取值，如 `{ fast: 'false' }`。 */
  parameters?: Readonly<Record<string, string>>;
}

/** 读取用户全局 cli-config 的 network 段；测试可注入以隔离真实用户目录。 */
export type CursorNetworkConfigReader = (baseEnv: NodeJS.ProcessEnv) => unknown;

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
  /** 可选的 network 来源；未注入时不继承用户配置，使用内置默认值。 */
  networkConfigReader?: CursorNetworkConfigReader;
  /** 可选的模型档位预写；省掉建会话后的 set_config_option 往返。 */
  modelSeed?: CursorModelSeed;
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
 * 显式读取用户全局 cli-config 的 `network` 段，供生产调用点选择性传入。
 * `useHttp1ForAgent` 是上游对付「h2 stream CANCEL / 反复重连」的逃生阀；
 * 隔离 config 写死会把它关死，用户在 Cursor 里打开也对 Cindy 会话无效。
 * 读不到就 undefined（用默认）。
 */
export function readUserNetworkConfigFromEnv(baseEnv: NodeJS.ProcessEnv): unknown {
  const dir = baseEnv.CURSOR_CONFIG_DIR?.trim() || join(homedir(), '.cursor');
  try {
    const raw = JSON.parse(readFileSync(join(dir, 'cli-config.json'), 'utf8')) as unknown;
    if (typeof raw !== 'object' || raw === null) return undefined;
    return (raw as Record<string, unknown>).network;
  } catch {
    return undefined;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 目录里已有的 cli-config；缺失 / 损坏 / 非对象一律 {}（回落成整写）。 */
function readExistingCliConfig(configDir: string): Record<string, unknown> {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(configDir, 'cli-config.json'), 'utf8'));
    return isPlainRecord(raw) ? raw : {};
  } catch {
    return {};
  }
}

/**
 * 同目录 tmp + rename。上游 cursor-agent 也这么写这个文件（`~/.cursor` 下能看到
 * `cli-config.json.<pid>.<uuid>.tmp`）；非原子写会让它读到写了一半的配置。
 */
function writeFileAtomic(filePath: string, contents: string): void {
  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmpPath, contents);
    renameSync(tmpPath, filePath);
  } catch {
    rmSync(tmpPath, { force: true });
    // Windows 上目标被占时 rename 会 EPERM：回落直写，代价只是极窄的撕裂读窗口。
    writeFileSync(filePath, contents);
  }
}

/** 同一模型下按 configOption id 合并：只覆盖要预写的项，保留上游记住的其余档位。 */
function mergeModelParameters(
  existing: unknown,
  parameters: Readonly<Record<string, string>>,
): Array<{ id: string; value: string }> {
  const merged = new Map<string, string>();
  if (Array.isArray(existing)) {
    for (const entry of existing) {
      if (!isPlainRecord(entry)) continue;
      const { id, value } = entry;
      if (typeof id === 'string' && typeof value === 'string') merged.set(id, value);
    }
  }
  for (const [id, value] of Object.entries(parameters)) merged.set(id, value);
  return [...merged].map(([id, value]) => ({ id, value }));
}

function applyModelSeed(
  target: Record<string, unknown>,
  existing: Record<string, unknown>,
  seed: CursorModelSeed,
): void {
  const existingParams = isPlainRecord(existing.modelParameters) ? existing.modelParameters : {};
  const parameters = mergeModelParameters(
    existingParams[seed.modelId],
    seed.parameters ?? {},
  );
  target.model = {
    modelId: seed.modelId,
    displayModelId: seed.modelId,
    displayName: seed.modelId,
    displayNameShort: seed.modelId,
    aliases: [],
    maxMode: false,
  };
  target.hasChangedDefaultModel = true;
  target.modelParameters = { ...existingParams, [seed.modelId]: parameters };
  target.selectedModel = { modelId: seed.modelId, parameters };
}

/**
 * 合并写：保留上游自己记在这个文件里的状态（模型档位、auth / 隐私缓存），只把
 * Cindy 必须钉住的键整棵子树覆盖回去。整写会让每次起会话都退回全冷状态。
 */
function writeIsolatedCliConfig(
  configDir: string,
  network: unknown,
  modelSeed?: CursorModelSeed,
): void {
  const existing = readExistingCliConfig(configDir);
  const cliConfig: Record<string, unknown> = {
    version: 1,
    ...existing,
    // 以下四键整棵子树覆盖，不做深合并 —— permissions 深合并会让上游写进来的
    // always-allow 授权跨重启存活，那是权限边界变化而不只是性能问题。
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
  if (modelSeed) applyModelSeed(cliConfig, existing, modelSeed);
  writeFileAtomic(join(configDir, 'cli-config.json'), `${JSON.stringify(cliConfig, null, 2)}\n`);
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
  const network = opts.networkConfigReader?.(baseEnv);
  writeIsolatedCliConfig(configDir, network, opts.modelSeed);

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
