import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentDeps, RemoteClaudeRoute } from '../../base-agent.js';
import type { AuthAdapter } from '../../../interfaces/auth-adapter.js';
import type { Logger } from '../../../interfaces/logger.js';

import { ClaudeCodeAgent } from '../index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  delete process.env.CLAUDE_CONFIG_DIR;
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function createNoopLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => createNoopLogger(),
  } as unknown as Logger;
}

function createDeps(overrides: Partial<AgentDeps> = {}): AgentDeps {
  const auth: AuthAdapter = {
    async getState() {
      return { authenticated: true };
    },
    async triggerLogin() {
      return { authenticated: true };
    },
    async logout() {},
    async getAuthEnv() {
      return {};
    },
  };
  return {
    auth,
    runtimeConfig: {},
    binaryPath: process.execPath,
    logger: createNoopLogger(),
    ...overrides,
  };
}

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maker-core-claude-hpf-'));
  tempDirs.push(dir);
  return dir;
}

type RemoteCcQueryFactoryArgs = Parameters<
  NonNullable<AgentDeps['remoteCcQueryFactory']>
>[0];

async function neverEndingQuery(): Promise<never> {
  await new Promise(() => {});
  throw new Error('unreachable');
}

describe('remote Claude session — loopback hostProxyForward passthrough', () => {
  it('透传 route.hostProxyForward 给 remoteCcQueryFactory(host 据此建 SSH 反向隧道)', async () => {
    const configDir = await makeTempDir();
    process.env.CLAUDE_CONFIG_DIR = configDir;
    const workingDir = await makeTempDir();

    const route: RemoteClaudeRoute = {
      endpoint: 'http://127.0.0.1:8080/anthropic',
      env: { ANTHROPIC_API_KEY: 'cindy-remote-no-auth' },
      hostProxyForward: { localUrl: 'http://localhost:8080/anthropic', remotePort: 8080 },
    };

    const remoteCcQueryFactory = vi.fn(async (_args: RemoteCcQueryFactoryArgs) => {
      // 消息流永远挂起的假 Query:远端分支 buildQuery 需要 async iterable + 控制方法。
      return {
        [Symbol.asyncIterator]: neverEndingQuery,
        setPermissionMode: vi.fn(async () => {}),
        setModel: vi.fn(async () => {}),
        applyFlagSettings: vi.fn(async () => {}),
        interrupt: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
        rewindFiles: vi.fn(async () => ({ canRewind: false })),
        stopTask: vi.fn(async () => {}),
      } as never;
    });

    const agent = new ClaudeCodeAgent(
      createDeps({
        remoteCcQueryFactory,
        resolveRemoteClaudeRoute: async () => route,
      }),
    );

    const handle = await agent.startSession({
      sessionId: 'session-hpf-passthrough',
      remoteHostId: 'remote-host',
      model: 'claude-opus-4-6',
      workingDir,
      permissionMode: 'acceptEdits',
    });

    await vi.waitFor(() => {
      expect(remoteCcQueryFactory).toHaveBeenCalledTimes(1);
    });
    const args = remoteCcQueryFactory.mock.calls[0]?.[0] as { hostProxyForward?: unknown };
    expect(args.hostProxyForward).toEqual({
      localUrl: 'http://localhost:8080/anthropic',
      remotePort: 8080,
    });

    // 透传的同时,startParams.env 的 ANTHROPIC_BASE_URL 必须是归一化后的远端可达 endpoint。
    const startParams = remoteCcQueryFactory.mock.calls[0]?.[0] as {
      startParams: { env: Record<string, string> };
    };
    expect(startParams.startParams.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8080/anthropic');

    await handle.close();
  });

  it('route 无 hostProxyForward(网关/远端可达上游)时不传该字段', async () => {
    const configDir = await makeTempDir();
    process.env.CLAUDE_CONFIG_DIR = configDir;
    const workingDir = await makeTempDir();

    const remoteCcQueryFactory = vi.fn(async (_args: RemoteCcQueryFactoryArgs) => {
      return {
        [Symbol.asyncIterator]: neverEndingQuery,
        setPermissionMode: vi.fn(async () => {}),
        setModel: vi.fn(async () => {}),
        applyFlagSettings: vi.fn(async () => {}),
        interrupt: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
        rewindFiles: vi.fn(async () => ({ canRewind: false })),
        stopTask: vi.fn(async () => {}),
      } as never;
    });

    const agent = new ClaudeCodeAgent(
      createDeps({
        remoteCcQueryFactory,
        resolveRemoteClaudeRoute: async () => ({
          endpoint: 'https://proxy.example.com',
          env: { ANTHROPIC_API_KEY: 'k' },
        }),
      }),
    );

    const handle = await agent.startSession({
      sessionId: 'session-hpf-none',
      remoteHostId: 'remote-host',
      model: 'claude-opus-4-6',
      workingDir,
      permissionMode: 'acceptEdits',
    });

    await vi.waitFor(() => {
      expect(remoteCcQueryFactory).toHaveBeenCalledTimes(1);
    });
    const args = remoteCcQueryFactory.mock.calls[0]?.[0] as { hostProxyForward?: unknown };
    expect(args.hostProxyForward).toBeUndefined();

    await handle.close();
  });

  it('loopback 上游但无 hostProxyForward → 仍被 defense-in-depth guard 拒绝(env 装错)', async () => {
    const configDir = await makeTempDir();
    process.env.CLAUDE_CONFIG_DIR = configDir;
    const workingDir = await makeTempDir();

    const agent = new ClaudeCodeAgent(
      createDeps({
        remoteCcQueryFactory: vi.fn(async (_args: RemoteCcQueryFactoryArgs) => {
          throw new Error('should not be called');
        }),
        resolveRemoteClaudeRoute: async () => ({
          // 模拟 host 组装出错误 env:loopback 上游却未挂隧道 —— guard 必须拒绝。
          endpoint: 'http://127.0.0.1:8080',
          env: {},
        }),
      }),
    );

    await expect(
      agent.startSession({
        sessionId: 'session-hpf-reject',
        remoteHostId: 'remote-host',
        model: 'claude-opus-4-6',
        workingDir,
        permissionMode: 'acceptEdits',
      }),
    ).rejects.toThrow(/REMOTE_COMPAT_MODE_UNSUPPORTED/);
  });
});
