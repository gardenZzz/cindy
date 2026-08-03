import { describe, expect, it } from 'vitest';

import {
  mergeDiskAndRuntimeSkills,
  parseAvailableCommandsUpdate,
  toAgentSkillCommands,
} from './availableCommands.js';

describe('parseAvailableCommandsUpdate', () => {
  it('returns null for unrelated session updates', () => {
    expect(
      parseAvailableCommandsUpdate({
        sessionId: 's',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } },
      }),
    ).toBeNull();
  });

  it('returns empty array when availableCommands is missing or not an array', () => {
    expect(
      parseAvailableCommandsUpdate({
        sessionId: 's',
        update: { sessionUpdate: 'available_commands_update' },
      }),
    ).toEqual([]);
    expect(
      parseAvailableCommandsUpdate({
        sessionId: 's',
        update: { sessionUpdate: 'available_commands_update', availableCommands: 'nope' },
      }),
    ).toEqual([]);
  });

  it('parses name / description / input.hint and strips leading slash', () => {
    expect(
      parseAvailableCommandsUpdate({
        sessionId: 's',
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: [
            { name: '/web', description: 'Search', input: { hint: 'query' } },
            { name: '  ', description: 'bad' },
            { name: 'test' },
            null,
            { description: 'no name' },
          ],
        },
      }),
    ).toEqual([
      { name: 'web', description: 'Search', inputHint: 'query' },
      { name: 'test' },
    ]);
  });
});

describe('toAgentSkillCommands', () => {
  it('maps to agent-skill entries for the slash palette', () => {
    expect(
      toAgentSkillCommands([
        { name: 'web', description: 'Search', inputHint: 'query' },
        { name: 'test' },
      ]),
    ).toEqual([
      {
        kind: 'agent-skill',
        name: 'web',
        description: 'Search (query)',
        source: 'user',
        enabled: true,
      },
      {
        kind: 'agent-skill',
        name: 'test',
        source: 'user',
        enabled: true,
      },
    ]);
  });
});

describe('mergeDiskAndRuntimeSkills', () => {
  it('keeps disk entry on name clash and adds ACP-only commands', () => {
    const disk = [
      {
        kind: 'agent-skill' as const,
        name: 'to-tickets',
        description: 'from disk',
        source: 'skill' as const,
        path: '/home/.agents/skills/to-tickets',
        enabled: true,
      },
    ];
    const runtime = [
      {
        kind: 'agent-skill' as const,
        name: 'to-tickets',
        description: 'from acp',
        source: 'user' as const,
        enabled: true,
      },
      {
        kind: 'agent-skill' as const,
        name: 'web',
        description: 'Search',
        source: 'user' as const,
        enabled: true,
      },
    ];
    expect(mergeDiskAndRuntimeSkills(disk, runtime)).toEqual([
      disk[0],
      runtime[1],
    ]);
  });
});
