import { describe, expect, it } from 'vitest';

import {
  CURSOR_STREAM_DISCONNECT_REASON,
  isCursorStreamDisconnectError,
} from './streamDisconnect.js';

describe('streamDisconnect', () => {
  it('exports CURSOR_STREAM_DISCONNECT_REASON constant', () => {
    expect(CURSOR_STREAM_DISCONNECT_REASON).toBe('cursor-stream-disconnect');
  });

  describe('isCursorStreamDisconnectError (Seam 1)', () => {
    it('matches HTTP/2 stream closed with error code CANCEL (0x8) error string', () => {
      const err = new Error(
        'RetriableError: [canceled] http/2 stream closed with error code CANCEL (0x8)',
      );
      expect(isCursorStreamDisconnectError(err)).toBe(true);
    });

    it('matches connection closed mid-response', () => {
      const err = new Error('connection closed mid-response');
      expect(isCursorStreamDisconnectError(err)).toBe(true);
    });

    it('matches stream ended unexpectedly', () => {
      const err = new Error('stream ended unexpectedly');
      expect(isCursorStreamDisconnectError(err)).toBe(true);
    });

    it('matches error objects with data containing message', () => {
      const err = Object.assign(new Error('acp session/prompt error'), {
        data: { message: 'http/2 stream closed with error code CANCEL (0x4)' },
      });
      expect(isCursorStreamDisconnectError(err)).toBe(true);
    });

    it('matches socket disconnected before TLS established', () => {
      const err = new Error(
        'RetriableError: [aborted] Client network socket disconnected before secure TLS connection was established',
      );
      expect(isCursorStreamDisconnectError(err)).toBe(true);
    });

    it('rejects ACP connection closed / transport failure', () => {
      expect(isCursorStreamDisconnectError(new Error('acp closed'))).toBe(false);
      expect(isCursorStreamDisconnectError(new Error('acp client closed'))).toBe(false);
      expect(isCursorStreamDisconnectError(new Error('stdio transport closed'))).toBe(false);
      expect(isCursorStreamDisconnectError(new Error('transport failure: process exited'))).toBe(false);
    });

    it('rejects session not found error', () => {
      const sid = '5e0f5314-7778-4eb6-a0b2-31b99d986dcf';
      const err = Object.assign(new Error('acp session/prompt error'), {
        data: { message: `Session "${sid}" not found` },
      });
      expect(isCursorStreamDisconnectError(err)).toBe(false);
    });

    it('rejects request timeouts and watchdog timeouts', () => {
      expect(isCursorStreamDisconnectError(new Error('request timed out'))).toBe(false);
      expect(isCursorStreamDisconnectError(new Error('tool_call_idle_timeout'))).toBe(false);
    });

    it('rejects RPC / auth / billing / invalid params errors', () => {
      expect(
        isCursorStreamDisconnectError(
          new Error('acp session/prompt error -32602: Invalid params'),
        ),
      ).toBe(false);
      expect(isCursorStreamDisconnectError(new Error('Unauthorized: login required'))).toBe(
        false,
      );
      expect(isCursorStreamDisconnectError(new Error('Quota exceeded'))).toBe(false);
    });

    it('returns false for empty or non-record values', () => {
      expect(isCursorStreamDisconnectError(null)).toBe(false);
      expect(isCursorStreamDisconnectError(undefined)).toBe(false);
      expect(isCursorStreamDisconnectError({})).toBe(false);
    });
  });
});
