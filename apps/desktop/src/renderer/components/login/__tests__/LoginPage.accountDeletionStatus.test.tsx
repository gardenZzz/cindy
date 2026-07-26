// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loginHook = vi.hoisted(() => ({
  value: {
    isLoading: false,
    errorCode: null,
    loginState: { step: 'browser-redirect' as const, label: 'Google' },
    hasAccountDeletionReceipt: true,
    getAccountDeletionStatus: vi.fn(),
    clearAccountDeletionReceipt: vi.fn(),
    dispatch: vi.fn(),
    clearError: vi.fn(),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ mode: 'signed-out', enterLocalMode: vi.fn() }),
}));

vi.mock('@/hooks/useBrandLogo', () => ({
  useBrandLogo: () => 'brand-logo.svg',
}));

vi.mock('@/hooks/useLogin', () => ({
  useLogin: () => loginHook.value,
}));

vi.mock('@/components/title-bar/WindowControls', () => ({
  WindowControls: () => null,
}));

import { LoginPage } from '../LoginPage';

describe('LoginPage account deletion status', () => {
  beforeEach(() => {
    loginHook.value.hasAccountDeletionReceipt = true;
    loginHook.value.getAccountDeletionStatus = vi.fn().mockResolvedValue({
      success: true,
      value: {
        status: 'pending',
        requestedAt: '2026-07-22T00:00:00.000Z',
        deleteAfter: '2026-08-21T00:00:00.000Z',
      },
    });
    loginHook.value.clearAccountDeletionReceipt = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { platform: 'darwin' },
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('shows the pending grace-period state while keeping sign-in available', async () => {
    render(<LoginPage />);

    expect(await screen.findByText('accountDeletion.status.pendingTitle')).toBeTruthy();
    expect(screen.getByText('login.browserWaiting')).toBeTruthy();
    expect(loginHook.value.getAccountDeletionStatus).toHaveBeenCalledOnce();
  });

  it('renders the status as an overlay bubble outside LoginStage (float, not in layout flow)', async () => {
    render(<LoginPage />);

    const bubble = await screen.findByRole('region', {
      name: 'accountDeletion.status.pendingTitle',
    });
    // 浮层定位类(figma 678:1075:窗口顶 72、z-30 盖过 stage、水平居中、宽 670 clamp)
    expect(bubble.className).toContain('absolute');
    expect(bubble.className).toContain('top-[72px]');
    expect(bubble.className).toContain('z-30');
    expect(bubble.className).toContain('left-1/2');
    expect(bubble.className).toContain('w-[min(670px,calc(100vw-48px))]');
    // 不再渲染进 LoginStage 文档流(修复前被 absolute 面板 100% 覆盖的 bug 根因)
    const stage = screen.getByTestId('login-stage');
    expect(stage.contains(bubble)).toBe(false);
    // pending 态无「我知道了」按钮
    expect(screen.queryByRole('button', { name: 'accountDeletion.status.dismissButton' })).toBeNull();
  });

  it('shows the processing state without a dismiss button', async () => {
    loginHook.value.getAccountDeletionStatus.mockResolvedValue({
      success: true,
      value: {
        status: 'processing',
        requestedAt: '2026-07-22T00:00:00.000Z',
        deleteAfter: '2026-08-21T00:00:00.000Z',
      },
    });
    render(<LoginPage />);

    expect(await screen.findByText('accountDeletion.status.processingTitle')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'accountDeletion.status.dismissButton' })).toBeNull();
  });

  it('lets the user dismiss a terminal completed receipt', async () => {
    loginHook.value.getAccountDeletionStatus.mockResolvedValue({
      success: true,
      value: {
        status: 'completed',
        requestedAt: '2026-07-22T00:00:00.000Z',
        deleteAfter: '2026-08-21T00:00:00.000Z',
        completedAt: '2026-08-21T00:05:00.000Z',
      },
    });
    render(<LoginPage />);

    const bubble = await screen.findByRole('region', {
      name: 'accountDeletion.status.completedTitle',
    });
    // completed 态才有「我知道了」下划线文字链
    const dismiss = screen.getByRole('button', {
      name: 'accountDeletion.status.dismissButton',
    });
    expect(bubble.contains(dismiss)).toBe(true);
    expect(dismiss.className).toContain('underline');

    fireEvent.click(dismiss);
    await waitFor(() => expect(loginHook.value.clearAccountDeletionReceipt).toHaveBeenCalledOnce());
    expect(screen.queryByText('accountDeletion.status.completedTitle')).toBeNull();
  });
});
