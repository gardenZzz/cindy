/**
 * buildCursorAcpMcpServers × 真实 codexHttpBridge 的接线验收。
 *
 * 单测那份（cursor-acp-mcp.test.ts）用 fake bridge 只锁形状；这里起真 bridge，
 * 按产出的 url + headers 真发 MCP 请求，验证只读代码看不出来的事：
 *   1. 默认主 token 全通，已启用的非协同 server（如 cindy_ssh）也可初始化；
 *   2. `?session=<id>` 真能把 cursor 的 session ctx 送进 tool handler；
 *   3. cleanup 注销后同一 URL 立刻 401（ctx 不残留）；
 *   4. 若测试强制注入 scoped persistent token，非白名单 server 仍 403。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getLiziMcpSessionContext } from '@cindy/mcps';

import type { Logger } from '@cindy/maker-core';
import { startCodexHttpBridge, type CodexHttpBridge } from '../../mcp-integrations/codexHttpBridge.js';
import { buildCursorAcpMcpServers } from '../cursor-acp-mcp.js';

const PERSISTENT_TOKEN = 'persistent-cursor-token';

function noopLogger(): Logger {
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

/** 回显 tool-call 时解析到的 session ctx —— 身份通道是否真的通了看它。 */
function createCtxEchoServer(): McpServer {
  const server = new McpServer({ name: 'cindy_orca', version: '1.0.0' });
  server.tool('current_session', 'Echo the resolved lizi MCP session context.', {}, async () => {
    const ctx = getLiziMcpSessionContext();
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            sessionId: ctx?.sessionId ?? null,
            agentKind: ctx?.agentKind ?? null,
            orcaRole: (ctx?.vendorOptions as Record<string, unknown> | undefined)?.orcaRole ?? null,
          }),
        },
      ],
    };
  });
  return server;
}

async function readRpcResponse(resp: Response): Promise<Record<string, unknown>> {
  const text = await resp.text();
  const eventPayload = text
    .split(/\r?\n/)
    .find((line) => line.startsWith('data: '))
    ?.slice('data: '.length);
  return JSON.parse(eventPayload ?? text) as Record<string, unknown>;
}

async function callCurrentSession(
  server: { url: string; headers: Array<{ name: string; value: string }> },
): Promise<{ initStatus: number; payload?: Record<string, unknown> }> {
  const headers: Record<string, string> = {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
  };
  for (const h of server.headers) headers[h.name.toLowerCase()] = h.value;

  const initResp = await fetch(server.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'cursor-acp-test', version: '1.0.0' },
      },
    }),
  });
  if (initResp.status !== 200) {
    await initResp.text();
    return { initStatus: initResp.status };
  }
  const mcpSessionId = initResp.headers.get('mcp-session-id') ?? '';
  await initResp.text();

  const callResp = await fetch(server.url, {
    method: 'POST',
    headers: { ...headers, 'mcp-session-id': mcpSessionId },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'current_session', arguments: {} },
    }),
  });
  return { initStatus: 200, payload: await readRpcResponse(callResp) };
}

describe('buildCursorAcpMcpServers × real codexHttpBridge', () => {
  let bridge: CodexHttpBridge | null = null;

  afterEach(async () => {
    await bridge?.shutdown();
    bridge = null;
  });

  async function startBridge(): Promise<CodexHttpBridge> {
    const started = await startCodexHttpBridge({
      serverFactories: {
        cindy_orca: createCtxEchoServer,
        orca_worker_bridge: createCtxEchoServer,
        cindy_ssh: createCtxEchoServer,
      },
      additionalBearerTokens: () => [PERSISTENT_TOKEN],
      logger: noopLogger(),
    });
    bridge = started;
    return started;
  }

  it('delivers the cursor session ctx to the tool handler through the produced url/headers', async () => {
    const started = await startBridge();
    const { servers, cleanup } = await buildCursorAcpMcpServers(
      {
        sessionId: 'worker-session-1',
        workingDir: '/repo',
        vendorOptions: { orcaRole: 'worker', orcaWorkerId: 'w-1' },
      },
      {
        ensureBridgeStarted: async () => ({
          port: started.port,
          serverNames: ['cindy_orca', 'orca_worker_bridge', 'cindy_ssh'],
          bridge: started,
        }),
      },
    );

    // 本地 Cursor 用主 token：全量已启用 lizi（含 cindy_ssh）都应下发。
    expect(servers.map((s) => s.name)).toEqual([
      'cindy_orca',
      'orca_worker_bridge',
      'cindy_ssh',
    ]);
    expect(servers[0].headers[0]?.value).toBe(`Bearer ${started.token}`);

    const { initStatus, payload } = await callCurrentSession(servers[0]);
    expect(initStatus).toBe(200);
    const text = (payload?.result as { content?: Array<{ text?: string }> } | undefined)
      ?.content?.[0]?.text;
    expect(JSON.parse(text ?? '{}')).toEqual({
      sessionId: 'worker-session-1',
      agentKind: 'cursor',
      orcaRole: 'worker',
    });

    // 非协同 server 在主 token 下也可初始化。
    const ssh = servers.find((s) => s.name === 'cindy_ssh');
    expect(ssh).toBeDefined();
    const sshInit = await callCurrentSession(ssh!);
    expect(sshInit.initStatus).toBe(200);

    // cleanup 后同一 URL 的 ?session= 不再命中注册表 → fail-closed 401。
    cleanup?.();
    const after = await callCurrentSession(servers[0]);
    expect(after.initStatus).toBe(401);
  });

  it('rejects a non-collab server when forced onto the scoped persistent token', async () => {
    const started = await startBridge();
    const { servers } = await buildCursorAcpMcpServers(
      { sessionId: 'lead-1', workingDir: '/repo', vendorOptions: { orcaRole: 'lead' } },
      {
        ensureBridgeStarted: async () => ({
          port: started.port,
          serverNames: ['cindy_orca', 'cindy_ssh'],
          bridge: started,
        }),
        // 显式注入 scoped token：验证远端白名单仍 fail-closed（本地默认不用这条路径）。
        getBridgeToken: () => PERSISTENT_TOKEN,
      },
    );
    expect(servers.map((s) => s.name)).toEqual(['cindy_orca', 'cindy_ssh']);
    const ssh = servers.find((s) => s.name === 'cindy_ssh')!;
    const { initStatus } = await callCurrentSession(ssh);
    expect(initStatus).toBe(403);
  });
});
