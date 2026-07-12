import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../api/client';
import { AuthProvider } from './AuthProvider';
import { ProtectedRoute } from './ProtectedRoute';

function LoginProbe() {
  const location = useLocation();
  const state = location.state as { from?: { pathname?: string } } | null;
  return <div>Login from {state?.from?.pathname ?? 'unknown'}</div>;
}

function renderRoutes() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/devices/device-1']}>
        <AuthProvider>
          <Routes>
            <Route element={<ProtectedRoute />}>
              <Route path="/devices/:id" element={<div>Protected device</div>} />
            </Route>
            <Route path="/login" element={<LoginProbe />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ProtectedRoute', () => {
  afterEach(() => vi.restoreAllMocks());

  it('redirects signed-out visitors and preserves the requested path', async () => {
    vi.spyOn(api, 'session').mockResolvedValue(null);
    renderRoutes();
    expect(await screen.findByText('Login from /devices/device-1')).toBeInTheDocument();
    expect(screen.queryByText('Protected device')).not.toBeInTheDocument();
  });

  it('renders protected content for an authenticated session', async () => {
    vi.spyOn(api, 'session').mockResolvedValue({
      csrfToken: 'csrf-token',
      user: { id: 'user-1', email: 'dev@example.com', createdAt: '2026-07-12T10:00:00.000Z' },
    });
    renderRoutes();
    expect(await screen.findByText('Protected device')).toBeInTheDocument();
  });

  it('shows the connectivity screen when the cached shell cannot reach the server', async () => {
    vi.spyOn(api, 'session').mockRejectedValue(
      new ApiError('RelayDock is unreachable.', 0, 'OFFLINE'),
    );
    renderRoutes();

    expect(await screen.findByText('RelayDock needs a connection')).toBeInTheDocument();
    expect(screen.getByText(/Jobs already accepted by your laptop continue running/)).toBeVisible();
  });
});
