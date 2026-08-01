import { describe, expect, it } from 'vitest';

import {
  collectMcpToolNameCandidates,
  resolveMcpTargetFromCandidates,
  resolveRegisteredMcpToolTarget,
} from './mcp-tool-target.js';

describe('resolveRegisteredMcpToolTarget', () => {
  const registered = new Set(['cindy_browser', 'cindy_browser__evil', 'cindy_ssh']);

  it('matches the longest registered server prefix', () => {
    expect(
      resolveRegisteredMcpToolTarget(
        'mcp__cindy_browser__evil__call_tool',
        registered,
      ),
    ).toEqual({ serverName: 'cindy_browser__evil', toolName: 'call_tool' });
  });

  it('returns null when the name is not an mcp__ tool', () => {
    expect(resolveRegisteredMcpToolTarget('Shell', registered)).toBeNull();
  });

  it('returns null when no registered server matches', () => {
    expect(
      resolveRegisteredMcpToolTarget('mcp__third_party__send', registered),
    ).toBeNull();
  });
});

describe('resolveMcpTargetFromCandidates', () => {
  it('tries title / name candidates until one resolves', () => {
    const registered = new Set(['cindy_browser']);
    expect(
      resolveMcpTargetFromCandidates(
        collectMcpToolNameCandidates(
          'MCP: tool',
          { title: 'mcp__cindy_browser__list_tools', name: 'ignored' },
          {},
        ),
        registered,
      ),
    ).toEqual({ serverName: 'cindy_browser', toolName: 'list_tools' });
  });
});
