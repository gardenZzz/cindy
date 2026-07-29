import { beforeEach, describe, expect, it } from 'vitest';

import {
  describeCursorHostError,
  describeRemoteError,
} from '@/device-link/remoteStatus';
import { i18n } from '@/i18n';

describe('cursor host compatibility errors (T9)', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh-CN');
  });

  it('turns old-desktop Cursor switch rejection into a readable message', () => {
    const message = describeCursorHostError(
      '[INVALID_PARAMS] targetAgentKind must be claude-code | codex',
      'cursor',
    );
    expect(message).toContain('Cursor');
    expect(message).toContain('升级');
  });

  it('turns old-desktop Cursor create rejection (agentKind required) into a readable message', () => {
    const message = describeCursorHostError(
      '[INVALID_PARAMS] agentKind required',
      'cursor',
    );
    expect(message).toBeTruthy();
    expect(message).toContain('Cursor');
    // 同错误在非 cursor 请求语境下不得误伤。
    expect(describeCursorHostError('[INVALID_PARAMS] agentKind required', 'codex')).toBeNull();
  });

  it('keeps App from treating Cursor rejection as an opaque crash string', () => {
    expect(describeRemoteError(
      '[INVALID_PARAMS] targetAgentKind must be claude-code | codex',
    )).toContain('Cursor');
  });
});
