/**
 * cursor-agent 三级探测单测 —— 临时目录模拟 ~/.local/bin、PATH、versions/，
 * 不依赖本机真实安装。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  createCursorBinaryDiscoveryDeps,
  discoverCursorAgentBinary,
  type CursorBinaryDiscoveryDeps,
} from '../cursor-binary-discovery.js';

async function makeHome(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'cindy-cursor-bin-'));
}

async function writeExec(filePath: string, body = '#!/bin/sh\necho ok\n'): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, body, { mode: 0o755 });
  await chmod(filePath, 0o755);
}

function liveDeps(homeDir: string, pathEnv?: string): CursorBinaryDiscoveryDeps {
  return {
    ...createCursorBinaryDiscoveryDeps('darwin'),
    homeDir,
    pathEnv,
    pathDelimiter: ':',
  };
}

describe('discoverCursorAgentBinary', () => {
  const homes: string[] = [];

  afterEach(async () => {
    await Promise.all(
      homes.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it('三级皆空 → installed: false', async () => {
    const home = await makeHome();
    homes.push(home);
    const status = await discoverCursorAgentBinary(liveDeps(home, ''));
    expect(status).toEqual({ installed: false });
  });

  it('优先命中 ~/.local/bin/cursor-agent（即使 PATH / versions 也有）', async () => {
    const home = await makeHome();
    homes.push(home);
    const localBin = path.join(home, '.local', 'bin', 'cursor-agent');
    const pathBin = path.join(home, 'path-bin', 'cursor-agent');
    const versionBin = path.join(
      home,
      '.local',
      'share',
      'cursor-agent',
      'versions',
      '2026.07.23-e383d2b',
      'cursor-agent',
    );
    await writeExec(localBin, '#!/bin/sh\necho local\n');
    await writeExec(pathBin, '#!/bin/sh\necho path\n');
    await writeExec(versionBin, '#!/bin/sh\necho version\n');

    const status = await discoverCursorAgentBinary(liveDeps(home, path.join(home, 'path-bin')));
    expect(status).toEqual({ installed: true, binaryPath: localBin });
  });

  it('local bin 缺失时走 PATH', async () => {
    const home = await makeHome();
    homes.push(home);
    const pathBin = path.join(home, 'path-bin', 'cursor-agent');
    await writeExec(pathBin);

    const status = await discoverCursorAgentBinary(liveDeps(home, path.join(home, 'path-bin')));
    expect(status).toEqual({ installed: true, binaryPath: pathBin });
  });

  it('local bin 与 PATH 皆空时取 versions 最新目录', async () => {
    const home = await makeHome();
    homes.push(home);
    const older = path.join(
      home,
      '.local',
      'share',
      'cursor-agent',
      'versions',
      '2026.07.17-3e2a980',
      'cursor-agent',
    );
    const newer = path.join(
      home,
      '.local',
      'share',
      'cursor-agent',
      'versions',
      '2026.07.23-e383d2b',
      'cursor-agent',
    );
    await writeExec(older, '#!/bin/sh\necho old\n');
    await writeExec(newer, '#!/bin/sh\necho new\n');

    const status = await discoverCursorAgentBinary(liveDeps(home, ''));
    expect(status).toEqual({ installed: true, binaryPath: newer });
  });

  it('versions 下跳过 .tmp 目录，且空目录不算命中', async () => {
    const home = await makeHome();
    homes.push(home);
    const versionsRoot = path.join(home, '.local', 'share', 'cursor-agent', 'versions');
    await mkdir(path.join(versionsRoot, '.tmp-2026.07.23-x'), { recursive: true });
    await mkdir(path.join(versionsRoot, '2026.07.23-empty'), { recursive: true });

    const status = await discoverCursorAgentBinary(liveDeps(home, ''));
    expect(status).toEqual({ installed: false });
  });

  it('不可执行文件不算已安装', async () => {
    const home = await makeHome();
    homes.push(home);
    const localBin = path.join(home, '.local', 'bin', 'cursor-agent');
    await mkdir(path.dirname(localBin), { recursive: true });
    await writeFile(localBin, 'not executable\n', { mode: 0o644 });
    await chmod(localBin, 0o644);

    const status = await discoverCursorAgentBinary(liveDeps(home, ''));
    expect(status).toEqual({ installed: false });
  });
});
