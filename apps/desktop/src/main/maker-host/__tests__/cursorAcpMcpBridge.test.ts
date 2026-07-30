/**
 * buildCursorAcpMcpServers × 真实 codexHttpBridge 的接线验收。
 *
 * 单测那份（cursor-acp-mcp.test.ts）用 fake bridge 只锁形状；这里起真 bridge，
 * 按产出的 url + headers 真发 MCP 请求，验证三条只读代码看不出来的事：
 *   1. persistent token 走 additionalBearerTokens 能过鉴权，且被 scope 到协同白名单；
 *   2. `?session=<id>` 真能把 cursor 的 session ctx 送进 tool handler；
 *   3. cleanup 注销后同一 URL 立刻 401（ctx 不残留）。
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
        getBridgeToken: () => PERSISTENT_TOKEN,
      },
    );

    // cindy_ssh 不在协同白名单，不该被下发。
    expect(servers.map((s) => s.name)).toEqual(['cindy_orca', 'orca_worker_bridge']);

    const { initStatus, payload } = await callCurrentSession(servers[0]);
    expect(initStatus).toBe(200);
    const text = (payload?.result as { content?: Array<{ text?: string }> } | undefined)
      ?.content?.[0]?.text;
    expect(JSON.parse(text ?? '{}')).toEqual({
      sessionId: 'worker-session-1',
      agentKind: 'cursor',
      orcaRole: 'worker',
    });

    // cleanup 后同一 URL 的 ?session= 不再命中注册表 → fail-closed 401。
    cleanup?.();
    const after = await callCurrentSession(servers[0]);
    expect(after.initStatus).toBe(401);
  });

  it('rejects a non-collab server even with a valid persistent token (scope guard)', async () => {
    const started = await startBridge();
    const { servers } = await buildCursorAcpMcpServers(
      { sessionId: 'lead-1', workingDir: '/repo', vendorOptions: { orcaRole: 'lead' } },
      {
        ensureBridgeStarted: async () => ({
          port: started.port,
          serverNames: ['cindy_orca'],
          bridge: started,
        }),
        getBridgeToken: () => PERSISTENT_TOKEN,
      },
    );
    // 手工把 URL 改指非白名单 server：拿到 token 也不得初始化其余本机 server。
    const forged = {
      ...servers[0],
      url: servers[0].url.replace('/mcp/cindy_orca', '/mcp/cindy_ssh'),
    };
    const { initStatus } = await callCurrentSession(forged);
    expect(initStatus).toBe(403);
  });
});
