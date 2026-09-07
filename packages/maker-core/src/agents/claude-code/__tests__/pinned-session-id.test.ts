/**
 * 新建 Claude 会话的 SDK session id 前置钉死。
 *
 * 不钉的话 host 要等 `system:init` 才知道 id,而它与首个 `/v1/messages` 只隔零点几秒 ——
 * 这个窗口里 loopback proxy 反解不出会话,per-session 路由落空,订阅会话的首个请求被换成
 * 网关 key 发去网关(表现为首轮 403 user_model_access_denied)。
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentDeps } from '../../base-agent.js';
import type { AuthAdapter } from '../../../interfaces/auth-adapter.js';
import type { Logger } from '../../../interfaces/logger.js';

const sdkMock = vi.hoisted(() => ({
  forkSession: vi.fn(),
  query: vi.fn(),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  forkSession: sdkMock.forkSession,
  query: sdkMock.query,
}));

import { ClaudeCodeAgent } from '../index.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const tempDirs: string[] = [];
const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;

function createNoopLogger(): Logger {
  const logger: Logger = {
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
    child() {
      return logger;
    },
  };
  return logger;
}

function createDeps(): AgentDeps {
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
  return { auth, runtimeConfig: {}, binaryPath: process.execPath, logger: createNoopLogger() };
}

/** 消息流永远挂起 —— 让 startSession 之后 SDK 不会再回填任何 session id。 */
function createFakeQuery() {
  return {
    [Symbol.asyncIterator]() {
      return { next: () => new Promise<IteratorResult<unknown>>(() => {}) };
    },
    setPermissionMode: vi.fn(async () => {}),
    setModel: vi.fn(async () => {}),
    applyFlagSettings: vi.fn(async () => {}),
    mcpServerStatus: vi.fn(async () => []),
    interrupt: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    rewindFiles: vi.fn(async () => ({ canRewind: false })),
  };
}

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maker-core-claude-pin-'));
  tempDirs.push(dir);
  return dir;
}

async function start(resumeSessionId?: string) {
  process.env.CLAUDE_CONFIG_DIR = await makeTempDir();
  sdkMock.query.mockReturnValue(createFakeQuery());
  const agent = new ClaudeCodeAgent(createDeps());
  const handle = await agent.startSession({
    sessionId: 'session-pin',
    model: 'claude-opus-4-6',
    workingDir: await makeTempDir(),
    permissionMode: 'acceptEdits',
    ...(resumeSessionId ? { resumeSessionId } : {}),
  });
  const options = sdkMock.query.mock.calls.at(-1)?.[0]?.options as
    | { sessionId?: string; resume?: string }
    | undefined;
  if (!options) throw new Error('expected sdk query options');
  return { handle, options };
}

afterEach(async () => {
  sdkMock.forkSession.mockReset();
  sdkMock.query.mockReset();
  if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('claude-code pinned sdk session id', () => {
  it('pins a fresh session id before spawn so handle.id is never <pending>', async () => {
    const { handle, options } = await start();
    expect(options.resume).toBeUndefined();
    expect(options.sessionId).toMatch(UUID_RE);
    // 这一条才是修复本身:proxy 靠 handle.id 反解会话,首个请求到达前就必须是真 id。
    expect(handle.id).toBe(options.sessionId);
  });

  it('leaves resume sessions alone (SDK forbids sessionId together with resume)', async () => {
    const { handle, options } = await start('11111111-2222-4333-8444-555555555555');
    expect(options.resume).toBe('11111111-2222-4333-8444-555555555555');
    expect(options.sessionId).toBeUndefined();
    expect(handle.id).toBe('11111111-2222-4333-8444-555555555555');
  });
});
