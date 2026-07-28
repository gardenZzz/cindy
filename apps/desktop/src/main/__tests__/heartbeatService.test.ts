import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface TestAuthState {
  mode: 'signed-out' | 'local' | 'cloud';
  isAuthenticated: boolean;
  user: { id: string } | null;
}

type AuthListener = (state: TestAuthState) => void;

const mocks = vi.hoisted(() => ({
  authState: {
    mode: 'signed-out',
    isAuthenticated: false,
    user: null,
  } as TestAuthState,
  authListener: null as AuthListener | null,
  authRealm: 'cn' as 'cn' | 'global',
  createHeartbeatClient: vi.fn(),
  heartbeatStop: vi.fn(),
  unsubscribeAuth: vi.fn(),
  onQuitDisposer: null as (() => void) | null,
  rendererSend: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { getVersion: () => '1.2.3-test' },
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: { send: mocks.rendererSend },
      },
    ],
  },
}));

vi.mock('@cindy/heartbeat-client', () => ({
  createHeartbeatClient: mocks.createHeartbeatClient,
}));

vi.mock('../authManager', () => ({
  getAuthState: () => mocks.authState,
  getActiveAuthRealm: () => mocks.authRealm,
  onAuthStateChange: (listener: AuthListener) => {
    mocks.authListener = listener;
    return mocks.unsubscribeAuth;
  },
}));

vi.mock('../clientEndpointsService', () => ({
  getClientEndpoint: () => `https://heartbeat.${mocks.authRealm}.example.test`,
}));

vi.mock('../lifecycle', () => ({
  onQuit: (_name: string, disposer: () => void) => {
    mocks.onQuitDisposer = disposer;
  },
}));

vi.mock('../logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
}));

function authState(mode: TestAuthState['mode'], userId: string | null = null): TestAuthState {
  return {
    mode,
    isAuthenticated: mode === 'cloud' && userId !== null,
    user: userId ? { id: userId } : null,
  };
}

function pushAuthState(state: TestAuthState): void {
  mocks.authState = state;
  mocks.authListener?.(state);
}

async function loadService(): Promise<typeof import('../heartbeatService')> {
  return import('../heartbeatService');
}

describe('heartbeat service app-mode isolation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 22, 23, 59, 0));
    vi.resetModules();
    mocks.authState = authState('signed-out');
    mocks.authRealm = 'cn';
    mocks.authListener = null;
    mocks.onQuitDisposer = null;
    mocks.createHeartbeatClient.mockReset().mockReturnValue({
      stop: mocks.heartbeatStop,
      running: true,
    });
    mocks.heartbeatStop.mockReset();
    mocks.unsubscribeAuth.mockReset();
    mocks.rendererSend.mockReset();
  });

  afterEach(() => {
    mocks.onQuitDisposer?.();
    vi.useRealTimers();
  });

  it('starts Cindy heartbeat only for a verified cloud session and stops on local mode', async () => {
    const { initHeartbeatService } = await loadService();
    initHeartbeatService();

    expect(mocks.createHeartbeatClient).not.toHaveBeenCalled();

    pushAuthState(authState('local'));
    expect(mocks.createHeartbeatClient).not.toHaveBeenCalled();

    pushAuthState(authState('cloud', 'cloud-user-1'));
    expect(mocks.createHeartbeatClient).toHaveBeenCalledTimes(1);

    const options = mocks.createHeartbeatClient.mock.calls[0][0];
    expect(options.endpoint).toBe('https://heartbeat.cn.example.test');
    expect(options.host.getUid()).toBe('cloud-user-1');

    pushAuthState(authState('local'));
    expect(mocks.heartbeatStop).toHaveBeenCalledTimes(1);
    expect(options.host.getUid()).toBeNull();
  });

  it('restarts Cindy heartbeat when the verified cloud owner changes', async () => {
    mocks.authState = authState('cloud', 'cloud-user-1');
    const { initHeartbeatService } = await loadService();
    initHeartbeatService();

    pushAuthState(authState('cloud', 'cloud-user-2'));

    expect(mocks.heartbeatStop).toHaveBeenCalledTimes(1);
    expect(mocks.createHeartbeatClient).toHaveBeenCalledTimes(2);
    expect(mocks.createHeartbeatClient.mock.calls[1][0].host.getUid()).toBe('cloud-user-2');
  });

  it('restarts Cindy heartbeat when the same authenticated owner moves to another realm', async () => {
    mocks.authState = authState('cloud', 'cloud-user-1');
    const { initHeartbeatService } = await loadService();
    initHeartbeatService();

    mocks.authRealm = 'global';
    pushAuthState(authState('cloud', 'cloud-user-1'));

    expect(mocks.heartbeatStop).toHaveBeenCalledTimes(1);
    expect(mocks.createHeartbeatClient).toHaveBeenCalledTimes(2);
    expect(mocks.createHeartbeatClient.mock.calls[1][0].endpoint).toBe(
      'https://heartbeat.global.example.test',
    );
  });

  it('keeps the TapDB daily-active cadence across signed-out, local, and cloud modes', async () => {
    const { initHeartbeatService } = await loadService();
    initHeartbeatService();

    vi.setSystemTime(new Date(2026, 6, 23, 0, 0, 0));
    await vi.advanceTimersByTimeAsync(60_000);

    pushAuthState(authState('local'));
    vi.setSystemTime(new Date(2026, 6, 24, 0, 0, 0));
    await vi.advanceTimersByTimeAsync(60_000);

    pushAuthState(authState('cloud', 'cloud-user-1'));
    vi.setSystemTime(new Date(2026, 6, 25, 0, 0, 0));
    await vi.advanceTimersByTimeAsync(60_000);

    expect(mocks.createHeartbeatClient).toHaveBeenCalledTimes(1);
    expect(mocks.rendererSend).toHaveBeenNthCalledWith(1, 'tapdb:daily-active', {
      date: '2026-07-23',
    });
    expect(mocks.rendererSend).toHaveBeenNthCalledWith(2, 'tapdb:daily-active', {
      date: '2026-07-24',
    });
    expect(mocks.rendererSend).toHaveBeenNthCalledWith(3, 'tapdb:daily-active', {
      date: '2026-07-25',
    });
  });

  it('cleans up both loops and the auth subscription on quit', async () => {
    mocks.authState = authState('cloud', 'cloud-user-1');
    const { initHeartbeatService } = await loadService();
    initHeartbeatService();

    mocks.onQuitDisposer?.();
    mocks.onQuitDisposer = null;
    vi.setSystemTime(new Date(2026, 6, 23, 0, 0, 0));
    await vi.advanceTimersByTimeAsync(60_000);

    expect(mocks.heartbeatStop).toHaveBeenCalledTimes(1);
    expect(mocks.unsubscribeAuth).toHaveBeenCalledTimes(1);
    expect(mocks.rendererSend).not.toHaveBeenCalled();
  });
});
