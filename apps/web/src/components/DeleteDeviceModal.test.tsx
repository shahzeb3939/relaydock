import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { DeleteDeviceModal } from './DeleteDeviceModal';

describe('DeleteDeviceModal', () => {
  it('clearly confirms the irreversible data deletion', () => {
    const onConfirm = vi.fn();
    render(
      <DeleteDeviceModal
        deviceName="Development laptop"
        error={null}
        loading={false}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />,
    );

    expect(screen.getByRole('dialog')).toHaveAccessibleName(
      'Permanently delete Development laptop?',
    );
    expect(
      screen.getByText(/job history, retained terminal output, and credentials/),
    ).toBeVisible();
    expect(screen.getByText(/Security audit records are retained/)).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('shows failures and prevents duplicate confirmation while deleting', () => {
    render(
      <DeleteDeviceModal
        deviceName="Development laptop"
        error="The device must be revoked first."
        loading
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('The device must be revoked first.');
    expect(screen.getByRole('button', { name: 'Deleting…' })).toBeDisabled();
  });
});
