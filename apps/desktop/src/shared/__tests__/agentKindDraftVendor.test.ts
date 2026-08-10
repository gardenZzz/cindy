import { describe, expect, it } from 'vitest';

import {
  agentKindToDraftPushSlot,
  agentKindToDraftVendor,
  isMakerCoreAgentKind,
  MAKER_CORE_AGENT_KINDS,
} from '../agentKindDraftVendor.js';

describe('agentKindDraftVendor', () => {
  it('三元 AgentKind → draft vendor / push slot 一一对应', () => {
    expect(agentKindToDraftVendor('claude-code')).toBe('cc');
    expect(agentKindToDraftVendor('codex')).toBe('codex');
    expect(agentKindToDraftVendor('cursor')).toBe('cursor');

    expect(agentKindToDraftPushSlot('claude-code')).toBe('claudeCode');
    expect(agentKindToDraftPushSlot('codex')).toBe('codex');
    expect(agentKindToDraftPushSlot('cursor')).toBe('cursor');
  });

  it('isMakerCoreAgentKind 接受 cursor（APPLY 兼容面）', () => {
    for (const kind of MAKER_CORE_AGENT_KINDS) {
      expect(isMakerCoreAgentKind(kind)).toBe(true);
    }
    expect(isMakerCoreAgentKind('gemini')).toBe(false);
    expect(isMakerCoreAgentKind('cc')).toBe(false);
  });
});
