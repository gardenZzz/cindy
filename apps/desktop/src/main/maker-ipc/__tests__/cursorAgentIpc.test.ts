/**
 * cursor-agent IPC：sender guard（不可信来源必须被拒）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  trusted: true,
  discover: vi.fn(async () => ({ installed: true, binaryPath: '/tmp/cursor-agent' })),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      h.handlers.set(channel, handler);
    }),
  },
}));

vi.mock('../../logger.js', () => ({
  createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: () => {
    if (!h.trusted) {
      throw new Error('[PERMISSION_DENIED] 此操作只能从 Cindy 主页面发起');
    }
  },
}));

vi.mock('../../maker-host/cursor-binary-discovery.js', () => ({
  discoverCursorAgentBinary: () => h.discover(),
}));

vi.mock('../../maker-host/cursor-agent-install.js', () => ({
  createRunCursorAgentInstallDeps: vi.fn(),
  isCursorAgentInstallSupported: () => true,
  runCursorAgentInstall: vi.fn(),
}));

vi.mock('../../utils/ipcValidate.js', () => ({
  throwIpcError: (code: string, message: string) => {
    throw new Error(`[${code}] ${message}`);
  },
}));

import { registerCursorAgentIpc } from '../cursor-agent.js';
import { MAKER_INVOKE } from '../channels.js';

const EVENT = {} as Electron.IpcMainInvokeEvent;

function invokeStatus(): Promise<unknown> {
  const handler = h.handlers.get(MAKER_INVOKE.CURSOR_BINARY_STATUS);
  if (!handler) throw new Error('CURSOR_BINARY_STATUS handler not registered');
  return Promise.resolve(handler(EVENT));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.handlers.clear();
  h.trusted = true;
  h.discover.mockResolvedValue({ installed: true, binaryPath: '/tmp/cursor-agent' });
  registerCursorAgentIpc();
});

describe('maker:cursor:binary-status — sender guard', () => {
  it('rejects untrusted sender before discovery', async () => {
    h.trusted = false;
    await expect(invokeStatus()).rejects.toThrow(/PERMISSION_DENIED/);
    expect(h.discover).not.toHaveBeenCalled();
  });

  it('allows trusted sender and returns installed status', async () => {
    await expect(invokeStatus()).resolves.toEqual({ installed: true });
    expect(h.discover).toHaveBeenCalledTimes(1);
  });
});
