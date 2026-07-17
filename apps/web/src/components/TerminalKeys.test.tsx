import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { TerminalKeys } from './TerminalKeys';

describe('TerminalKeys', () => {
  it('sends the exact control sequences an interactive TUI expects', () => {
    const onKey = vi.fn();
    render(<TerminalKeys onKey={onKey} onFocusKeyboard={vi.fn()} disabled={false} />);

    fireEvent.click(screen.getByRole('button', { name: 'Up arrow' }));
    fireEvent.click(screen.getByRole('button', { name: 'Down arrow' }));
    fireEvent.click(screen.getByRole('button', { name: 'Enter' }));
    fireEvent.click(screen.getByRole('button', { name: 'Escape' }));
    fireEvent.click(screen.getByRole('button', { name: 'Interrupt (Ctrl+C)' }));

    expect(onKey.mock.calls.map((call) => call[0])).toEqual([
      '\x1b[A',
      '\x1b[B',
      '\r',
      '\x1b',
      '\x03',
    ]);
  });

  it('summons the on-screen keyboard without emitting any input', () => {
    const onKey = vi.fn();
    const onFocusKeyboard = vi.fn();
    render(<TerminalKeys onKey={onKey} onFocusKeyboard={onFocusKeyboard} disabled={false} />);

    fireEvent.click(screen.getByRole('button', { name: '⌨ Keyboard' }));

    expect(onFocusKeyboard).toHaveBeenCalledOnce();
    expect(onKey).not.toHaveBeenCalled();
  });

  it('disables every key while the stream is not writable', () => {
    render(<TerminalKeys onKey={vi.fn()} onFocusKeyboard={vi.fn()} disabled />);

    for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled();
  });
});
