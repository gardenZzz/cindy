import { describe, expect, it } from 'vitest';

import {
  ACP_AUTO_ALLOW_KINDS,
  autoClassifierAllowsKind,
  findPermissionOption,
  sessionAllowKeyFromToolCall,
  toInteractionRequest,
  toRequestPermissionResult,
  toolInputFromAcpToolCall,
  toolNameFromAcpToolCall,
} from './permissions.js';
import type { PermissionOption } from './protocol.js';

const OPTIONS: PermissionOption[] = [
  { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
  { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
];

describe('ACP permission mapping', () => {
  it('maps execute toolCall to exec + command input', () => {
    const toolCall = {
      toolCallId: 't1',
      title: '`uname -s`',
      kind: 'execute' as const,
      rawInput: { command: 'uname -s' },
    };
    expect(toolNameFromAcpToolCall(toolCall)).toBe('exec');
    expect(toolInputFromAcpToolCall(toolCall)).toEqual({ command: 'uname -s' });
    expect(sessionAllowKeyFromToolCall(toolCall)).toBe('execute:uname');
  });

  it('builds InteractionRequest with sessionAllowKey metadata', () => {
    const req = toInteractionRequest({
      requestId: 'r1',
      params: {
        sessionId: 's1',
        toolCall: {
          toolCallId: 't1',
          title: '`ls`',
          kind: 'execute',
          status: 'pending',
          rawInput: { command: 'ls' },
          content: [
            {
              type: 'content',
              content: { type: 'text', text: 'Shell allowlist is empty' },
            },
          ],
        },
        options: OPTIONS,
      },
      suggestions: [{ destination: 'session', sessionAllowKey: 'execute:ls' }],
    });
    expect(req).toMatchObject({
      kind: 'permission',
      requestId: 'r1',
      toolName: 'exec',
      input: { command: 'ls' },
      description: 'Shell allowlist is empty',
    });
    expect(req.kind === 'permission' && req.metadata?.sessionAllowKey).toBe('execute:ls');
  });

  it('never selects allow-always even when user asks for session grant', () => {
    const allowAlways = findPermissionOption(OPTIONS, 'allow_always');
    expect(allowAlways?.optionId).toBe('allow-always');

    const result = toRequestPermissionResult(
      {
        kind: 'permission',
        behavior: 'allow',
        permissionUpdates: [{ destination: 'session', sessionAllowKey: 'execute:uname' }],
      },
      OPTIONS,
    );
    expect(result).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    });
    expect(JSON.stringify(result)).not.toContain('allow-always');
  });

  it('maps deny to reject-once', () => {
    expect(
      toRequestPermissionResult({ kind: 'permission', behavior: 'deny' }, OPTIONS),
    ).toEqual({
      outcome: { outcome: 'selected', optionId: 'reject-once' },
    });
  });

  it('auto classifier allows only read/search/think', () => {
    expect(ACP_AUTO_ALLOW_KINDS.has('read')).toBe(true);
    expect(autoClassifierAllowsKind('read')).toBe(true);
    expect(autoClassifierAllowsKind('search')).toBe(true);
    expect(autoClassifierAllowsKind('think')).toBe(true);
    expect(autoClassifierAllowsKind('execute')).toBe(false);
    expect(autoClassifierAllowsKind('edit')).toBe(false);
    expect(autoClassifierAllowsKind(undefined)).toBe(false);
  });
});
