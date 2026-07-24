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

import { PlanChangeStatusDialog } from '../PlanChangeDialog';
import type { PlanChangeState } from '../usePlanChange';

function quoteReadyState(overrides: Partial<PlanChangeState> = {}): PlanChangeState {
  return {
    open: true,
    phase: 'QUOTE_READY',
    planChange: {
      planChangeId: 'plan_change_1',
      changeType: 'UPGRADE',
      status: 'QUOTED',
      quotedAmountMinor: 1500,
      quotedCurrency: 'cny',
      quoteExpiresAt: '2099-01-01T00:00:00.000Z',
      effectiveAt: '2026-08-01T00:00:00.000Z',
      paymentAction: null,
    },
    targetPlan: null,
    error: false,
    stale: false,
    ...overrides,
  };
}

describe('PlanChangeStatusDialog stale snapshot handling', () => {
  beforeEach(() => {
    confirm.mockReset().mockResolvedValue(true);
  });

  it('lets a fresh quote be confirmed or abandoned', () => {
    render(
      <PlanChangeStatusDialog
        state={quoteReadyState()}
        targetName={null}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        onRefresh={vi.fn()}
        onAbandon={vi.fn()}
      />,
    );

    expect(screen.getByText('billing.planChange.confirm')).toBeTruthy();
    expect(screen.getByText('billing.planChange.abandon')).toBeTruthy();
    expect(screen.queryByText('billing.actions.refresh')).toBeNull();
  });

  it('never offers confirm or abandon on a stale snapshot, only resync', () => {
    const onRefresh = vi.fn();
    render(
      <PlanChangeStatusDialog
        state={quoteReadyState({ error: true, stale: true })}
        targetName={null}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        onRefresh={onRefresh}
        onAbandon={vi.fn()}
      />,
    );

    expect(screen.queryByText('billing.planChange.confirm')).toBeNull();
    expect(screen.queryByText('billing.planChange.abandon')).toBeNull();
    expect(screen.getByText('billing.planChange.resyncHint')).toBeTruthy();

    fireEvent.click(screen.getByText('billing.actions.refresh'));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('shows provider-pending progress without offering another confirm', () => {
    const onRefresh = vi.fn();
    render(
      <PlanChangeStatusDialog
        state={quoteReadyState({
          phase: 'PENDING_PROVIDER',
          planChange: {
            ...quoteReadyState().planChange!,
            status: 'PENDING_PROVIDER',
          },
        })}
        targetName={null}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        onRefresh={onRefresh}
        onAbandon={vi.fn()}
      />,
    );

    expect(screen.getByText('billing.planChange.pendingProviderTitle')).toBeTruthy();
    expect(screen.getByText('billing.planChange.pendingProviderBody')).toBeTruthy();
    expect(screen.queryByText('billing.planChange.confirm')).toBeNull();
    expect(screen.queryByText('billing.planChange.abandon')).toBeNull();

    fireEvent.click(screen.getByText('billing.actions.refresh'));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('does not submit the final change until confirmation is accepted', async () => {
    const onConfirm = vi.fn();
    render(
      <PlanChangeStatusDialog
        state={quoteReadyState()}
        targetName="Plus"
        onClose={vi.fn()}
        onConfirm={onConfirm}
        onRefresh={vi.fn()}
        onAbandon={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('billing.planChange.confirm'));
    expect(onConfirm).not.toHaveBeenCalled();
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        confirmText: 'billing.confirmActions.confirmPlanChange',
        autoFocusConfirm: true,
      }),
    );
  });

  it('keeps the quote when cancel-plan-change confirmation is declined', async () => {
    confirm.mockResolvedValue(false);
    const onAbandon = vi.fn();
    render(
      <PlanChangeStatusDialog
        state={quoteReadyState()}
        targetName="Plus"
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        onRefresh={vi.fn()}
        onAbandon={onAbandon}
      />,
    );

    fireEvent.click(screen.getByText('billing.planChange.abandon'));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(onAbandon).not.toHaveBeenCalled();
  });
});
