import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createToolIdleWatchdog,
  formatCursorToolIdleMessage,
  resolveCursorToolIdleMs,
} from './toolIdleWatchdog.js';

describe('resolveCursorToolIdleMs', () => {
  it('defaults to 300s', () => {
    expect(resolveCursorToolIdleMs({})).toBe(300_000);
  });

  it('reads CINDY_CURSOR_TOOL_IDLE_MS', () => {
    expect(resolveCursorToolIdleMs({ CINDY_CURSOR_TOOL_IDLE_MS: '1500' })).toBe(1500);
  });

  it('falls back on invalid values', () => {
    expect(resolveCursorToolIdleMs({ CINDY_CURSOR_TOOL_IDLE_MS: '0' })).toBe(300_000);
    expect(resolveCursorToolIdleMs({ CINDY_CURSOR_TOOL_IDLE_MS: '-1' })).toBe(300_000);
    expect(resolveCursorToolIdleMs({ CINDY_CURSOR_TOOL_IDLE_MS: 'nope' })).toBe(300_000);
  });
});

describe('createToolIdleWatchdog', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not arm until a tool is active', () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const w = createToolIdleWatchdog({ idleMs: 1000, onTimeout });
    w.noteActivity();
    vi.advanceTimersByTime(5000);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('trips after idleMs with no activity while tool pending', () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const w = createToolIdleWatchdog({ idleMs: 1000, onTimeout });
    w.noteToolActive('t1');
    vi.advanceTimersByTime(999);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledOnce();
    expect(onTimeout.mock.calls[0][0]).toEqual({
      idleMs: 1000,
      pendingToolIds: ['t1'],
    });
  });

  it('resets timer on activity', () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const w = createToolIdleWatchdog({ idleMs: 1000, onTimeout });
    w.noteToolActive('t1');
    vi.advanceTimersByTime(800);
    w.noteActivity();
    vi.advanceTimersByTime(800);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(onTimeout).toHaveBeenCalledOnce();
  });

  it('stops after tool terminal and clear()', () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const w = createToolIdleWatchdog({ idleMs: 1000, onTimeout });
    w.noteToolActive('t1');
    w.noteToolTerminal('t1');
    vi.advanceTimersByTime(5000);
    expect(onTimeout).not.toHaveBeenCalled();

    w.noteToolActive('t2');
    w.clear();
    vi.advanceTimersByTime(5000);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('does not trip while suspended by a human interaction', () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const w = createToolIdleWatchdog({ idleMs: 1000, onTimeout });
    w.noteToolActive('t1');
    w.suspend();
    vi.advanceTimersByTime(5000);
    expect(onTimeout).not.toHaveBeenCalled();
    expect(w.suspendedDepth()).toBe(1);
  });

  it('re-arms after resume once interaction settles', () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const w = createToolIdleWatchdog({ idleMs: 1000, onTimeout });
    w.noteToolActive('t1');
    w.suspend();
    vi.advanceTimersByTime(5000);
    w.resume();
    vi.advanceTimersByTime(999);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledOnce();
    expect(w.suspendedDepth()).toBe(0);
  });

  it('nested suspends require matching resumes', () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const w = createToolIdleWatchdog({ idleMs: 1000, onTimeout });
    w.noteToolActive('t1');
    w.suspend();
    w.suspend();
    w.resume();
    vi.advanceTimersByTime(5000);
    expect(onTimeout).not.toHaveBeenCalled();
    w.resume();
    vi.advanceTimersByTime(1000);
    expect(onTimeout).toHaveBeenCalledOnce();
  });

  it('resume with nothing suspended is a no-op', () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const w = createToolIdleWatchdog({ idleMs: 1000, onTimeout });
    w.noteToolActive('t1');
    w.resume();
    expect(w.suspendedDepth()).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(onTimeout).toHaveBeenCalledOnce();
  });

  it('clear() resets suspend depth', () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const w = createToolIdleWatchdog({ idleMs: 1000, onTimeout });
    w.noteToolActive('t1');
    w.suspend();
    w.clear();
    expect(w.suspendedDepth()).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('formats a readable timeout message', () => {
    expect(formatCursorToolIdleMessage(300_000)).toContain('300s');
    expect(formatCursorToolIdleMessage(300_000)).toContain('无活动');
    expect(formatCursorToolIdleMessage(300_000)).toContain('自动续跑');
  });
});
