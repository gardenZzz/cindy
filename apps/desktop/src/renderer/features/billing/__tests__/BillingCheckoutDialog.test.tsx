// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const confirm = vi.hoisted(() => vi.fn());

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
  }),
}));
vi.mock('qrcode', () => ({
  toDataURL: vi.fn(async () => 'data:image/png;base64,fixture'),
}));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm }),
}));

import { BillingCheckoutDialog } from '../BillingCheckoutDialog';
import type { BillingCheckoutState } from '../useBillingCheckout';

function topupState(overrides: Partial<BillingCheckoutState> = {}): BillingCheckoutState {
  return {
    open: true,
    kind: 'TOPUP',
    phase: 'AWAITING_PAYMENT',
    intent: null,
    order: {
      orderId: 'order_fixture',
      productCode: 'credit_topup',
      offerCode: 'credit_topup_20',
      amount: '20',
      currency: 'cny',
      status: 'PENDING',
      fulfillmentStatus: 'NOT_STARTED',
      paymentAction: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:01:00.000Z',
    },
    subscription: null,
    error: false,
    ...overrides,
  };
}

describe('BillingCheckoutDialog confirmations', () => {
  beforeEach(() => {
    confirm.mockReset().mockResolvedValue(true);
  });

  it('cancels a pending payment only after confirmation is accepted', async () => {
    confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const onCancel = vi.fn();
    render(
      <BillingCheckoutDialog
        state={topupState()}
        onClose={vi.fn()}
        onRefresh={vi.fn()}
        onRetry={vi.fn()}
        onCancel={onCancel}
      />,
    );

    fireEvent.click(screen.getByText('billing.actions.cancelPayment'));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(onCancel).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('billing.actions.cancelPayment'));
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
    expect(confirm).toHaveBeenLastCalledWith(
      expect.objectContaining({
        confirmText: 'billing.confirmActions.cancelPayment',
      }),
    );
  });

  it('retries an expired payment only after confirmation is accepted', async () => {
    const onRetry = vi.fn();
    render(
      <BillingCheckoutDialog
        state={topupState({
          phase: 'EXPIRED',
          order: {
            ...topupState().order!,
            status: 'EXPIRED',
          },
        })}
        onClose={vi.fn()}
        onRefresh={vi.fn()}
        onRetry={onRetry}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('billing.actions.retry'));
    expect(onRetry).not.toHaveBeenCalled();
    await waitFor(() => expect(onRetry).toHaveBeenCalledTimes(1));
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        confirmText: 'billing.confirmActions.retryPayment',
        autoFocusConfirm: true,
      }),
    );
  });

  it('refreshes payment status without confirmation', () => {
    const onRefresh = vi.fn();
    render(
      <BillingCheckoutDialog
        state={topupState()}
        onClose={vi.fn()}
        onRefresh={onRefresh}
        onRetry={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('billing.actions.refresh'));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
  });
});
