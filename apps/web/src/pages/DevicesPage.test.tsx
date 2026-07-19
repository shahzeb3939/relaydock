import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Device, PairingCode } from '../api/types';
import { buildAgentInstallCommand } from '../lib/agentInstall';
import { DeviceCard, PairDeviceModal } from './DevicesPage';

const pairing: PairingCode = {
  code: 'ABCD-EFGH',
  expiresAt: '2099-07-13T12:00:00.000Z',
};

const pairedDevice: Device = {
  id: '33d58cdf-2dd8-4805-a0c2-b08744947c22',
  name: 'Development laptop',
  platform: 'darwin',
  architecture: 'arm64',
  agentVersion: '0.1.0',
  status: 'offline',
  lastSeenAt: '2026-07-13T08:00:00.000Z',
  createdAt: '2026-07-12T08:00:00.000Z',
  updatedAt: '2026-07-13T08:00:00.000Z',
};

function renderModal(overrides: Partial<ComponentProps<typeof PairDeviceModal>> = {}) {
  const props: ComponentProps<typeof PairDeviceModal> = {
    pairing,
    loading: false,
    error: null,
    onClose: vi.fn(),
    onGenerate: vi.fn(),
    ...overrides,
  };
  render(<PairDeviceModal {...props} />);
  return props;
}

describe('PairDeviceModal', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('explains the one-command setup before generating a code', () => {
    const props = renderModal({ pairing: null });

    expect(screen.getByText(/No Go installation or repository checkout is needed/)).toBeVisible();
    expect(
      screen.getByText(/automatically whenever you log in, including after a restart/),
    ).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Generate pairing code' }));
    expect(props.onGenerate).toHaveBeenCalledOnce();
  });

  it('copies the exact installer command and explains that pairing persists', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    renderModal();

    const expected = buildAgentInstallCommand(window.location.origin, pairing.code);
    expect(screen.getByLabelText('RelayDock setup command')).toHaveTextContent(expected);
    expect(screen.getByText(/you do not need to pair it again/)).toBeVisible();
    expect(
      screen.getByText(/revoke the device or delete its local agent configuration/),
    ).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Copy command' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expected));
    expect(screen.getByRole('button', { name: 'Copied' })).toBeVisible();
  });

  it('shows a manual-copy fallback when clipboard access fails', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    renderModal();

    fireEvent.click(screen.getByRole('button', { name: 'Copy command' }));

    expect(
      await screen.findByText(
        'Could not copy automatically. Select and copy the command manually.',
      ),
    ).toBeVisible();
  });

  it('can request a fresh pairing code', () => {
    const props = renderModal();

    fireEvent.click(screen.getByRole('button', { name: 'Regenerate code' }));

    expect(props.onGenerate).toHaveBeenCalledOnce();
  });
});

describe('DeviceCard', () => {
  it('keeps rarely-used actions tucked inside a kebab menu', () => {
    render(
      <MemoryRouter>
        <DeviceCard
          device={pairedDevice}
          onRename={vi.fn()}
          onRevoke={vi.fn()}
          onDelete={vi.fn()}
        />
      </MemoryRouter>,
    );

    // The card only surfaces "Open device" up front; actions stay hidden until asked for.
    expect(screen.getByRole('link', { name: /Open device/ })).toBeInTheDocument();
    expect(
      screen.queryByRole('menuitem', { name: 'Rename Development laptop' }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Development laptop' }));

    expect(screen.getByRole('menuitem', { name: 'Rename Development laptop' })).toBeInTheDocument();
  });

  it('offers revocation while a device is active', () => {
    const onRevoke = vi.fn();
    render(
      <MemoryRouter>
        <DeviceCard
          device={pairedDevice}
          onRename={vi.fn()}
          onRevoke={onRevoke}
          onDelete={vi.fn()}
        />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Development laptop' }));
    expect(
      screen.queryByRole('menuitem', { name: 'Permanently delete Development laptop' }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Revoke Development laptop' }));

    expect(onRevoke).toHaveBeenCalledWith(pairedDevice);
  });

  it('offers permanent deletion only after revocation', () => {
    const revokedDevice = { ...pairedDevice, status: 'revoked' as const };
    const onDelete = vi.fn();
    render(
      <MemoryRouter>
        <DeviceCard
          device={revokedDevice}
          onRename={vi.fn()}
          onRevoke={vi.fn()}
          onDelete={onDelete}
        />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Development laptop' }));
    expect(
      screen.queryByRole('menuitem', { name: 'Revoke Development laptop' }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('menuitem', { name: 'Permanently delete Development laptop' }),
    );

    expect(onDelete).toHaveBeenCalledWith(revokedDevice);
  });

  it('lets an owner start renaming a device', () => {
    const onRename = vi.fn();
    render(
      <MemoryRouter>
        <DeviceCard
          device={pairedDevice}
          onRename={onRename}
          onRevoke={vi.fn()}
          onDelete={vi.fn()}
        />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Development laptop' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename Development laptop' }));

    expect(onRename).toHaveBeenCalledWith(pairedDevice);
  });
});
