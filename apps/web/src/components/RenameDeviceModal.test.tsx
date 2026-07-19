import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { RenameDeviceModal } from './RenameDeviceModal';

describe('RenameDeviceModal', () => {
  it('submits the trimmed new name', () => {
    const onRename = vi.fn();
    render(
      <RenameDeviceModal
        currentName="192.168.1.12"
        error={null}
        loading={false}
        onClose={vi.fn()}
        onRename={onRename}
      />,
    );

    expect(screen.getByRole('dialog')).toHaveAccessibleName('Rename device');
    const input = screen.getByLabelText(/Device name/);
    fireEvent.change(input, { target: { value: '  MacBook Pro  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));

    expect(onRename).toHaveBeenCalledWith('MacBook Pro');
  });

  it('keeps saving disabled until the name actually changes', () => {
    const onRename = vi.fn();
    render(
      <RenameDeviceModal
        currentName="Development laptop"
        error={null}
        loading={false}
        onClose={vi.fn()}
        onRename={onRename}
      />,
    );

    expect(screen.getByRole('button', { name: 'Save name' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/Device name/), { target: { value: '   ' } });
    expect(screen.getByRole('button', { name: 'Save name' })).toBeDisabled();
  });

  it('shows failures and blocks a duplicate submit while saving', () => {
    render(
      <RenameDeviceModal
        currentName="Development laptop"
        error="That name is already taken."
        loading
        onClose={vi.fn()}
        onRename={vi.fn()}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('That name is already taken.');
    expect(screen.getByRole('button', { name: /Saving…/ })).toBeDisabled();
  });
});
