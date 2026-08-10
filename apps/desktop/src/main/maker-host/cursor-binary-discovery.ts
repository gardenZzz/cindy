/**
 * cursor-agent 本机三级探测 —— 用户自装，不走 agent-binaries 下载式 provisioning。
 *
 * 顺序：`~/.local/bin/cursor-agent` → PATH → `~/.local/share/cursor-agent/versions/`（取最新）。
 * 探测失败一律 `{ installed: false }`，不抛错、不阻塞启动（Cursor 全程可选）。
 */

import { accessSync, constants, readdirSync, statSync } from 'node:fs';
import { access, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export type CursorBinaryStatus =
  | { installed: true; binaryPath: string }
  | { installed: false };

const BINARY_NAME = 'cursor-agent';

export interface CursorBinaryDiscoveryDeps {
  homeDir: string;
  /** `process.env.PATH`；缺省时跳过 PATH 级。 */
  pathEnv: string | undefined;
  pathDelimiter: string;
  /** 存在且为普通文件（跟随 symlink）。 */
  isFile(candidate: string): Promise<boolean>;
  /** Unix 上额外校验可执行位；Windows 上可恒 true（由 isFile 兜底）。 */
  isExecutable(candidate: string): Promise<boolean>;
  /** 列目录名；目录不存在 / 不可读时返回空数组。 */
  listDirNames(dir: string): Promise<string[]>;
}

export interface CursorBinaryDiscoverySyncDeps {
  homeDir: string;
  pathEnv: string | undefined;
  pathDelimiter: string;
  isFile(candidate: string): boolean;
  isExecutable(candidate: string): boolean;
  listDirNames(dir: string): string[];
}

export function createCursorBinaryDiscoveryDeps(
  platform: NodeJS.Platform = process.platform,
): CursorBinaryDiscoveryDeps {
  return {
    homeDir: homedir(),
    pathEnv: process.env.PATH,
    pathDelimiter: path.delimiter,
    isFile: async (candidate) => {
      try {
        return (await stat(candidate)).isFile();
      } catch {
        return false;
      }
    },
    isExecutable: async (candidate) => {
      if (platform === 'win32') return true;
      try {
        await access(candidate, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
    listDirNames: async (dir) => {
      try {
        return await readdir(dir);
      } catch {
        return [];
      }
    },
  };
}

/** getMaker() 同步构造路径用；语义与 async 版一致。 */
export function createCursorBinaryDiscoverySyncDeps(
  platform: NodeJS.Platform = process.platform,
): CursorBinaryDiscoverySyncDeps {
  return {
    homeDir: homedir(),
    pathEnv: process.env.PATH,
    pathDelimiter: path.delimiter,
    isFile: (candidate) => {
      try {
        return statSync(candidate).isFile();
      } catch {
        return false;
      }
    },
    isExecutable: (candidate) => {
      if (platform === 'win32') return true;
      try {
        accessSync(candidate, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
    listDirNames: (dir) => {
      try {
        return readdirSync(dir);
      } catch {
        return [];
      }
    },
  };
}

async function acceptBinary(
  candidate: string,
  deps: CursorBinaryDiscoveryDeps,
): Promise<string | null> {
  if (!(await deps.isFile(candidate))) return null;
  if (!(await deps.isExecutable(candidate))) return null;
  return candidate;
}

function acceptBinarySync(
  candidate: string,
  deps: CursorBinaryDiscoverySyncDeps,
): string | null {
  if (!deps.isFile(candidate)) return null;
  if (!deps.isExecutable(candidate)) return null;
  return candidate;
}

/** PATH 步进；不引 which 包（与 shellResolver 同口径）。 */
async function resolveOnPath(
  bin: string,
  deps: CursorBinaryDiscoveryDeps,
): Promise<string | null> {
  const pathEnv = deps.pathEnv;
  if (!pathEnv) return null;
  for (const dir of pathEnv.split(deps.pathDelimiter)) {
    if (!dir) continue;
    const hit = await acceptBinary(path.join(dir, bin), deps);
    if (hit) return hit;
  }
  return null;
}

function resolveOnPathSync(bin: string, deps: CursorBinaryDiscoverySyncDeps): string | null {
  const pathEnv = deps.pathEnv;
  if (!pathEnv) return null;
  for (const dir of pathEnv.split(deps.pathDelimiter)) {
    if (!dir) continue;
    const hit = acceptBinarySync(path.join(dir, bin), deps);
    if (hit) return hit;
  }
  return null;
}

/**
 * 版本目录取最新：名字按字典序降序（官方目录形如 `2026.07.23-e383d2b`，日期前缀可排序）。
 * 跳过以 `.` 开头的临时目录。
 */
async function resolveLatestVersionBinary(
  versionsRoot: string,
  deps: CursorBinaryDiscoveryDeps,
): Promise<string | null> {
  const names = (await deps.listDirNames(versionsRoot))
    .filter((name) => name.length > 0 && !name.startsWith('.'))
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  for (const name of names) {
    const hit = await acceptBinary(path.join(versionsRoot, name, BINARY_NAME), deps);
    if (hit) return hit;
  }
  return null;
}

function resolveLatestVersionBinarySync(
  versionsRoot: string,
  deps: CursorBinaryDiscoverySyncDeps,
): string | null {
  const names = deps
    .listDirNames(versionsRoot)
    .filter((name) => name.length > 0 && !name.startsWith('.'))
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  for (const name of names) {
    const hit = acceptBinarySync(path.join(versionsRoot, name, BINARY_NAME), deps);
    if (hit) return hit;
  }
  return null;
}

export async function discoverCursorAgentBinary(
  deps: CursorBinaryDiscoveryDeps = createCursorBinaryDiscoveryDeps(),
): Promise<CursorBinaryStatus> {
  const localBin = await acceptBinary(
    path.join(deps.homeDir, '.local', 'bin', BINARY_NAME),
    deps,
  );
  if (localBin) return { installed: true, binaryPath: localBin };

  const fromPath = await resolveOnPath(BINARY_NAME, deps);
  if (fromPath) return { installed: true, binaryPath: fromPath };

  const fromVersions = await resolveLatestVersionBinary(
    path.join(deps.homeDir, '.local', 'share', 'cursor-agent', 'versions'),
    deps,
  );
  if (fromVersions) return { installed: true, binaryPath: fromVersions };

  return { installed: false };
}

/** 同步版：供 getMaker() 同步装配路径。失败一律 `{ installed: false }`。 */
export function discoverCursorAgentBinarySync(
  deps: CursorBinaryDiscoverySyncDeps = createCursorBinaryDiscoverySyncDeps(),
): CursorBinaryStatus {
  try {
    const localBin = acceptBinarySync(
      path.join(deps.homeDir, '.local', 'bin', BINARY_NAME),
      deps,
    );
    if (localBin) return { installed: true, binaryPath: localBin };

    const fromPath = resolveOnPathSync(BINARY_NAME, deps);
    if (fromPath) return { installed: true, binaryPath: fromPath };

    const fromVersions = resolveLatestVersionBinarySync(
      path.join(deps.homeDir, '.local', 'share', 'cursor-agent', 'versions'),
      deps,
    );
    if (fromVersions) return { installed: true, binaryPath: fromVersions };

    return { installed: false };
  } catch {
    return { installed: false };
  }
}
