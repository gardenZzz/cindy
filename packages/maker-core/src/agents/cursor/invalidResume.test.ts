import { describe, expect, it } from 'vitest';

import { isCursorResumeSessionNotFound } from './invalidResume.js';

describe('isCursorResumeSessionNotFound', () => {
  const sid = '5e0f5314-7778-4eb6-a0b2-31b99d986dcf';

  it('matches Cursor ACP Invalid params + Session "id" not found', () => {
    const err = Object.assign(new Error('acp session/load error -32602: Invalid params'), {
      code: -32602,
      data: { message: `Session "${sid}" not found` },
    });
    expect(isCursorResumeSessionNotFound(err, sid)).toBe(true);
  });

  it('rejects a different session id in the not-found message', () => {
    const err = Object.assign(new Error('Invalid params'), {
      data: { message: 'Session "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" not found' },
    });
    expect(isCursorResumeSessionNotFound(err, sid)).toBe(false);
  });

  it('rejects unrelated timeouts and network errors', () => {
    expect(isCursorResumeSessionNotFound(new Error('socket timed out'), sid)).toBe(false);
    expect(isCursorResumeSessionNotFound(new Error('ECONNRESET'), sid)).toBe(false);
    expect(isCursorResumeSessionNotFound(new Error('acp closed'), sid)).toBe(false);
  });

  it('returns false for empty expected id', () => {
    expect(
      isCursorResumeSessionNotFound(
        { data: { message: `Session "${sid}" not found` } },
        '',
      ),
    ).toBe(false);
  });
});
