import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { KebabMenu } from './KebabMenu';

function setup(onSelect = vi.fn()) {
  render(
    <KebabMenu
      ariaLabel="Actions"
      items={[
        { label: 'Rename', onSelect },
        { label: 'Revoke', danger: true, onSelect: vi.fn() },
      ]}
    />,
  );
  return { onSelect, trigger: screen.getByRole('button', { name: 'Actions' }) };
}

describe('KebabMenu', () => {
  it('stays collapsed until the trigger is activated', () => {
    const { trigger } = setup();

    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument();

    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByRole('menuitem')).toHaveLength(2);
  });

  it('runs the selected action and closes the menu', () => {
    const { onSelect, trigger } = setup();
    fireEvent.click(trigger);

    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));

    expect(onSelect).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument();
  });

  it('closes on Escape and returns focus to the trigger', () => {
    const { trigger } = setup();
    fireEvent.click(trigger);

    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });

    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('closes when a click lands outside the menu', () => {
    const { trigger } = setup();
    fireEvent.click(trigger);

    fireEvent.pointerDown(document.body);

    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument();
  });

  it('moves focus between items with the arrow keys', () => {
    const { trigger } = setup();
    fireEvent.click(trigger);

    const [rename, revoke] = screen.getAllByRole('menuitem');
    expect(rename).toHaveFocus();

    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' });
    expect(revoke).toHaveFocus();

    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' });
    expect(rename).toHaveFocus();
  });
});
