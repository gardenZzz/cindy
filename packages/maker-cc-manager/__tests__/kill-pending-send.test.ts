/**
 * Greptile P1 回归:forceful kill 的终止窗口内 (inputQueue 已 end、consume
 * loop 未退出、alive 仍 true), sendMessage 必须显式拒绝
 * (SESSION_KILL_PENDING) — 不得把消息 push 进 ended queue 静默丢弃。
 */

import { describe, expect, it } from 'vitest';

import {
  SessionRegistry,
  type SdkQueryFactory,
  type SdkQueryLike,
} from '../src/session-registry.js';

function buildBlockingFactory(): SdkQueryFactory {
  return (opts): SdkQueryLike => {
    async function* gen(): AsyncGenerator<unknown> {
      yield { type: 'system', subtype: 'init', session_id: 'sdk-uuid', cwd: opts.cwd, model: opts.model };
      for await (const _ of opts.inputStream) {
        // drain
      }
      // inputQueue 已 end, 但 consume loop 还在等"SDK 的最终响应" — 正是
      // Greptile 描述的「alive 仍 true 的终止窗口」(interrupt 发出到
      // consume loop 真正退出之间)。
      await new Promise((r) => setTimeout(r, 150));
      yield { type: 'result', subtype: 'success' };
    }
    const g = gen();
    return {
      [Symbol.asyncIterator]: () => g,
      async interrupt() {},
      async setModel() {},
      async setPermissionMode() {},
      async applyFlagSettings() {},
    };
  };
}

describe('kill 终止窗口的 sendMessage 拒绝 (Greptile P1)', () => {
  it('rejects sendMessage with SESSION_KILL_PENDING while a forceful kill is still settling', async () => {
    const registry = new SessionRegistry({ sdkQueryFactory: buildBlockingFactory() });
    const session = await registry.create({ sessionId: 's1', cwd: '/repo', model: 'm', env: {} });

    // kill 发出后 consume loop 仍挂在线上 (inputStream 未消费新消息) —
    // alive 为 true、inputQueue 已 end 的窗口期。
    const killP = registry.kill('s1');
    // kill 内的 interrupt/end 是同步微任务, 先让它推进到窗口态。
    await new Promise((r) => setTimeout(r, 20));
    expect(session.alive).toBe(true); // 窗口确认:registry 仍报 alive

    expect(() => registry.sendMessage('s1', { text: 'hello' })).toThrowError(/SESSION_KILL_PENDING|being killed/);

    await killP;
  });

  it('still throws SESSION_NOT_FOUND after the session fully exits (not the kill-pending code)', async () => {
    const registry = new SessionRegistry({ sdkQueryFactory: buildBlockingFactory() });
    await registry.create({ sessionId: 's2', cwd: '/repo', model: 'm', env: {} });

    await registry.close('s2'); // close 路径: alive 立即 false
    expect(() => registry.sendMessage('s2', { text: 'hello' })).toThrowError(/SESSION_NOT_FOUND|no longer alive/);
  });
});
