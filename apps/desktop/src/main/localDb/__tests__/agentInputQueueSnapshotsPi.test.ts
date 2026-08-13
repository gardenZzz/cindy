import { describe, expect, it } from 'vitest';

import type { AgentKind } from '@cindy/maker-core';

import { isRestorableQueuedMessage } from '../agentInputQueueSnapshots.js';

/**
 * 每种 AgentKind 都要能恢复:漏一种 = 那种 agent 的会话崩溃重启后整条排队队列被
 * 静默丢弃(Pi 与 Cursor 先后踩过同一个坑)。用 Record 列举而不是数组字面量,
 * 新增 AgentKind 时本文件与被测的白名单一起编译不过。
 */
const ALL_AGENT_KINDS: Record<AgentKind, true> = {
  'claude-code': true,
  codex: true,
  cursor: true,
  pi: true,
};

function queued(agentKind: AgentKind) {
  return {
    clientId: 'client-1',
    text: 'continue',
    persistedContent: 'continue',
    chatMessage: { role: 'user', content: 'continue' },
    createOpts: { agentKind },
  };
}

describe('agent input queue snapshot restore', () => {
  it.each(Object.keys(ALL_AGENT_KINDS) as AgentKind[])(
    'accepts the %s agent kind',
    (agentKind) => {
      expect(isRestorableQueuedMessage(queued(agentKind))).toBe(true);
    },
  );

  it('rejects an unknown agent kind', () => {
    expect(
      isRestorableQueuedMessage({ ...queued('pi'), createOpts: { agentKind: 'unknown' } }),
    ).toBe(false);
  });

  it('rejects inherited Object.prototype keys as agent kinds', () => {
    // 白名单从三元链改成对象查表后的边界:'toString' 这类原型链上的键不能算命中。
    expect(
      isRestorableQueuedMessage({ ...queued('pi'), createOpts: { agentKind: 'toString' } }),
    ).toBe(false);
  });
});
