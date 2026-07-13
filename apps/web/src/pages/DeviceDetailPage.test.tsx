import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { api } from '../api/client';
import { queryKeys } from '../api/queryKeys';
import type { Device, DeviceDetails } from '../api/types';
import { DeviceDetailPage } from './DeviceDetailPage';

const revokedDevice: Device = {
  id: '33d58cdf-2dd8-4805-a0c2-b08744947c22',
  name: 'Development laptop',
  platform: 'darwin',
  architecture: 'arm64',
  agentVersion: '0.1.0',
  status: 'revoked',
  lastSeenAt: '2026-07-13T08:00:00.000Z',
  createdAt: '2026-07-12T08:00:00.000Z',
  updatedAt: '2026-07-13T08:00:00.000Z',
};

const details: DeviceDetails = {
  device: revokedDevice,
  repositories: [],
  recentJobs: [],
};

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });
  queryClient.setQueryData(queryKeys.device(revokedDevice.id), details);
  queryClient.setQueryData(queryKeys.devices, [revokedDevice]);
  queryClient.setQueryData(queryKeys.repository('repository-1'), { id: 'repository-1' });
  queryClient.setQueryData(queryKeys.job('job-1'), { id: 'job-1' });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/devices/${revokedDevice.id}`]}>
        <Routes>
          <Route path="/devices/:deviceId" element={<DeviceDetailPage />} />
          <Route path="/devices" element={<div>Devices destination</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return queryClient;
}

describe('DeviceDetailPage permanent deletion', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows the revoked state and gates the permanent action', () => {
    renderPage();

    expect(screen.getByText(/has been revoked and can no longer reconnect/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Delete device' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Revoke device' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Delete device' }));
    expect(screen.getByRole('dialog')).toHaveAccessibleName(
      'Permanently delete Development laptop?',
    );
  });

  it('deletes the device, clears dependent caches, and returns to the device list', async () => {
    const deleteDevice = vi.spyOn(api, 'deleteDevice').mockResolvedValue(undefined);
    const queryClient = renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Delete device' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }));

    expect(await screen.findByText('Devices destination')).toBeVisible();
    expect(deleteDevice).toHaveBeenCalledWith(revokedDevice.id);
    await waitFor(() => {
      expect(queryClient.getQueryData(queryKeys.device(revokedDevice.id))).toBeUndefined();
      expect(queryClient.getQueryData(queryKeys.repository('repository-1'))).toBeUndefined();
      expect(queryClient.getQueryData(queryKeys.job('job-1'))).toBeUndefined();
    });
    expect(queryClient.getQueryData<Device[]>(queryKeys.devices)).toEqual([]);
  });
});
