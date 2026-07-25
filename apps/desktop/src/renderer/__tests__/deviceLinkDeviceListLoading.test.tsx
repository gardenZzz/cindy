// @vitest-environment jsdom

import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useDeviceLinkDeviceList initial request', () => {
  it('marks a rejected initial device-list request as settled without fabricating an empty list', async () => {
    const listDevices = vi.fn().mockRejectedValue(new Error('relay unavailable'));
    vi.stubGlobal('electronAPI', {
      deviceLink: {
        listDevices,
        onPresenceChanged: vi.fn(),
        onStatusChanged: vi.fn(),
        onControlTargetChanged: vi.fn(),
      },
    });

    const {
      useDeviceLinkDeviceList,
      useDeviceLinkDeviceListSettled,
    } = await import('@/features/device-link/useDeviceLinkDeviceList');
    const { result } = renderHook(() => ({
      devices: useDeviceLinkDeviceList(),
      settled: useDeviceLinkDeviceListSettled(),
    }));

    expect(result.current).toEqual({ devices: null, settled: false });
    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(result.current.devices).toBeNull();
    expect(listDevices).toHaveBeenCalledTimes(1);
  });
});
