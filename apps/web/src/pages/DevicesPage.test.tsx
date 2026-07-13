import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PairingCode } from '../api/types';
import { buildAgentInstallCommand } from '../lib/agentInstall';
import { PairDeviceModal } from './DevicesPage';

const pairing: PairingCode = {
  code: 'ABCD-EFGH',
  expiresAt: '2099-07-13T12:00:00.000Z',
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
