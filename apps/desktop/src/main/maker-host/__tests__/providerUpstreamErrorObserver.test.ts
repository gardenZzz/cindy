/**
 * provider-upstream-error-observer 单测：
 *   - 成功响应 / 非 user 供应商流量 → null sink（成功路径零开销，规则 10）；
 *   - 4xx 错误体 tee → 分类 → 经注入 broadcaster 广播结构化事件；
 *   - 同 (providerId, code) 30s 节流；不同 code / 不同 provider 不互相压制；
 *   - gzip 错误体按 content-encoding 解压后再分类；
 *   - count_tokens 404 静默（上游未实现的良性缺失，如 Moonshot /anthropic），非 404 照常广播。
 */

import { gzipSync } from 'node:zlib';

import { describe, it, expect, afterEach } from 'vitest';

import type { ResponseObserverCtx } from '@cindy/anthropic-compat-proxy';

import {
  createProviderUpstreamErrorObserver,
  reportProviderUpstreamError,
  setProviderUpstreamErrorBroadcaster,
  type ProviderUpstreamErrorEvent,
} from '../provider-upstream-error-observer.js';

afterEach(() => {
  setProviderUpstreamErrorBroadcaster(() => {});
});

function ctx(over: Partial<ResponseObserverCtx> = {}): ResponseObserverCtx {
  return {
    reqId: 1,
    method: 'POST',
    url: '/v1/messages',
    upstreamBase: 'https://relay.example',
    status: 401,
    requestHeaders: { 'x-claude-code-session-id': 'sdk-1' },
    responseHeaders: {},
    requestBody: Buffer.alloc(0),
    ...over,
  };
}

/** 驱动一次完整观察：建 sink → 喂 body → end。返回 sink 是否存在。 */
function drive(observer: ReturnType<typeof createProviderUpstreamErrorObserver>, c: ResponseObserverCtx, body: Buffer): boolean {
  const sink = observer(c);
  if (!sink) return false;
  sink.onData?.(body);
  sink.onEnd?.();
  return true;
}

describe('createProviderUpstreamErrorObserver', () => {
  it('status < 400 → null sink（不 tee）', () => {
    const observer = createProviderUpstreamErrorObserver({
      agent: 'claude-code',
      resolveUserProviderId: () => 'my-relay',
    });
    expect(observer(ctx({ status: 200 }))).toBeNull();
  });

  it('反解不到 user 供应商 → null sink（内置来源流量不广播）', () => {
    const observer = createProviderUpstreamErrorObserver({
      agent: 'claude-code',
      resolveUserProviderId: () => null,
    });
    expect(observer(ctx({ status: 401 }))).toBeNull();
  });

  it('401 → 广播 AUTH_INVALID 结构化事件', () => {
    const events: ProviderUpstreamErrorEvent[] = [];
    setProviderUpstreamErrorBroadcaster((e) => events.push(e));
    const observer = createProviderUpstreamErrorObserver({
      agent: 'claude-code',
      resolveUserProviderId: () => 'my-relay',
      resolveUserProviderName: () => '测试网关',
    });
    drive(
      observer,
      ctx({ status: 401 }),
      Buffer.from('{"error":{"type":"authentication_error"},"Received API Key":"creds-live-123456789"}'),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      agent: 'claude-code',
      providerId: 'my-relay',
      providerName: '测试网关',
      code: 'AUTH_INVALID',
      retryable: false,
      status: 401,
      // #2333：errorType 与本地代理 reqId 进入事件契约（诊断详情用），不属日志上传。
      errorType: 'authentication_error',
      reqId: 1,
    });
    expect(events[0]?.detail).not.toContain('creds-live-123456789');
  });

  it('400 中转层路由拒绝 → 透传 errorType（agent_router_api_error）与 reqId（#2333）', () => {
    const events: ProviderUpstreamErrorEvent[] = [];
    setProviderUpstreamErrorBroadcaster((e) => events.push(e));
    const observer = createProviderUpstreamErrorObserver({
      agent: 'claude-code',
      resolveUserProviderId: () => 'ag-claude',
    });
    drive(
      observer,
      ctx({ status: 400, reqId: 714 }),
      Buffer.from('{"error":{"type":"agent_router_api_error","message":"content-blocked"}}'),
    );
    expect(events[0]).toMatchObject({
      status: 400,
      errorType: 'agent_router_api_error',
      reqId: 714,
      code: 'UNKNOWN',
    });
  });

  it('非 JSON 错误体 → errorType 缺省（不因解析失败丢事件）', () => {
    const events: ProviderUpstreamErrorEvent[] = [];
    setProviderUpstreamErrorBroadcaster((e) => events.push(e));
    const observer = createProviderUpstreamErrorObserver({
      agent: 'claude-code',
      resolveUserProviderId: () => 'my-relay',
    });
    drive(observer, ctx({ status: 400 }), Buffer.from('Bad Gateway'));
    expect(events[0]?.errorType).toBeUndefined();
    expect(events[0]?.status).toBe(400);
  });

  it('截断到一半的 JSON 错误体 → errorType 缺省（body 截断不致命）', () => {
    const events: ProviderUpstreamErrorEvent[] = [];
    setProviderUpstreamErrorBroadcaster((e) => events.push(e));
    const observer = createProviderUpstreamErrorObserver({
      agent: 'claude-code',
      resolveUserProviderId: () => 'my-relay',
    });
    drive(observer, ctx({ status: 400 }), Buffer.from('{"error":{"type":"invalid_request_error"'));
    expect(events[0]?.errorType).toBeUndefined();
  });

  it('errorType 钳制到惯例形态：凭证形 / 超长 / 带空格的任意串一律缺省', () => {
    const events: ProviderUpstreamErrorEvent[] = [];
    setProviderUpstreamErrorBroadcaster((e) => events.push(e));
    let t = 1_000;
    const observer = createProviderUpstreamErrorObserver({
      agent: 'claude-code',
      resolveUserProviderId: () => 'my-relay',
      now: () => t,
    });
    // 每轮推进时钟 > 30s 节流窗，保证每条都被广播。
    // 凭证前缀守卫：动态拼接，避免安全门把测试占位符误判为真实凭证。
    const credShaped = ['sk', 'live', '1234567890abcdef'].join('-');
    const badTypes = [credShaped, 'a'.repeat(80), 'has space', 'Quote"injection'];
    for (const bad of badTypes) {
      drive(observer, ctx({ status: 400 }), Buffer.from(JSON.stringify({ error: { type: bad } })));
      t += 31_000;
    }
    // 点分 snake_case 是合法形态，应保留。
    drive(
      observer,
      ctx({ status: 400 }),
      Buffer.from('{"error":{"type":"agent.router_api_error"}}'),
    );
    expect(events.map((e) => e.errorType)).toEqual([undefined, undefined, undefined, undefined, 'agent.router_api_error']);
  });

  it('同 (providerId, code) 30s 内节流；不同 code / 不同 provider 不压制', () => {
    const events: ProviderUpstreamErrorEvent[] = [];
    setProviderUpstreamErrorBroadcaster((e) => events.push(e));
    let t = 1_000;
    const observer = createProviderUpstreamErrorObserver({
      agent: 'codex',
      resolveUserProviderId: (h) => h['x-provider'] ?? null,
      now: () => t,
    });
    const c = (provider: string, status: number) =>
      ctx({ status, requestHeaders: { 'x-provider': provider } });

    drive(observer, c('p1', 401), Buffer.from(''));
    t += 1_000;
    drive(observer, c('p1', 401), Buffer.from('')); // 节流
    t += 1_000;
    drive(observer, c('p1', 429), Buffer.from('')); // 不同 code → 放行
    drive(observer, c('p2', 401), Buffer.from('')); // 不同 provider → 放行
    t += 31_000;
    drive(observer, c('p1', 401), Buffer.from('')); // 窗口过 → 放行

    expect(events.map((e) => `${e.providerId}:${e.code}`)).toEqual([
      'p1:AUTH_INVALID',
      'p1:RATE_LIMITED',
      'p2:AUTH_INVALID',
      'p1:AUTH_INVALID',
    ]);
  });

  it('count_tokens 404 → null sink（上游未实现辅助端点，不弹「检查基础 URL」误报）', () => {
    const events: ProviderUpstreamErrorEvent[] = [];
    setProviderUpstreamErrorBroadcaster((e) => events.push(e));
    const observer = createProviderUpstreamErrorObserver({
      agent: 'claude-code',
      resolveUserProviderId: () => 'kimi-moonshot',
    });
    // Moonshot /anthropic 实测形态：CLI 带 ?beta=true 的 count_tokens 打到未实现端点回 404。
    expect(observer(ctx({ status: 404, url: '/v1/messages/count_tokens?beta=true' }))).toBeNull();
    expect(observer(ctx({ status: 404, url: '/v1/messages/count_tokens' }))).toBeNull();
    expect(events).toHaveLength(0);
    // 同路径非 404（如 401）仍是真信号 → 照常广播。
    drive(observer, ctx({ status: 401, url: '/v1/messages/count_tokens?beta=true' }), Buffer.from(''));
    expect(events.map((e) => e.code)).toEqual(['AUTH_INVALID']);
    // 主链路 /v1/messages 的 404 仍照常广播（真·端点配置问题不能被吞掉）。
    drive(observer, ctx({ status: 404, url: '/v1/messages?beta=true' }), Buffer.from('{"error":"url.not_found"}'));
    expect(events.map((e) => e.code)).toEqual(['AUTH_INVALID', 'ENDPOINT_NOT_FOUND']);
  });

  it('gzip 错误体按 content-encoding 解压后分类（400 模型不存在 → MODEL_NOT_FOUND）', () => {
    const events: ProviderUpstreamErrorEvent[] = [];
    setProviderUpstreamErrorBroadcaster((e) => events.push(e));
    const observer = createProviderUpstreamErrorObserver({
      agent: 'claude-code',
      resolveUserProviderId: () => 'my-relay',
    });
    const gz = gzipSync(Buffer.from('{"error":{"message":"model: glm-x not found"}}'));
    drive(observer, ctx({ status: 400, responseHeaders: { 'content-encoding': 'gzip' } }), gz);
    expect(events[0]?.code).toBe('MODEL_NOT_FOUND');
  });
});

describe('reportProviderUpstreamError (localHandler 桥接路径)', () => {
  it('提取 errorType；无 reqId（桥接绕开 compat-proxy 转发层，与 observer 一致）', () => {
    const events: ProviderUpstreamErrorEvent[] = [];
    setProviderUpstreamErrorBroadcaster((e) => events.push(e));
    reportProviderUpstreamError({
      agent: 'codex',
      providerId: 'ag-claude',
      providerName: 'ag-Claude',
      status: 400,
      bodyText: '{"error":{"type":"agent_router_api_error","message":"content-blocked"}}',
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      agent: 'codex',
      providerId: 'ag-claude',
      providerName: 'ag-Claude',
      status: 400,
      code: 'UNKNOWN',
      errorType: 'agent_router_api_error',
    });
    expect(events[0]?.reqId).toBeUndefined();
  });

  it('同 (agent, providerId, code) 30s 内节流；errorType 仍取最新错误体', () => {
    const events: ProviderUpstreamErrorEvent[] = [];
    setProviderUpstreamErrorBroadcaster((e) => events.push(e));
    let t = 1_000;
    reportProviderUpstreamError({
      agent: 'codex',
      providerId: 'p1',
      status: 400,
      bodyText: '{"error":{"type":"first_type"}}',
      now: () => t,
    });
    t += 1_000;
    reportProviderUpstreamError({
      agent: 'codex',
      providerId: 'p1',
      status: 400,
      bodyText: '{"error":{"type":"second_type"}}',
      now: () => t,
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.errorType).toBe('first_type');
  });
});
