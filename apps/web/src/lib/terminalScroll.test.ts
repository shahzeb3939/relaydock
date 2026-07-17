import { describe, expect, it } from 'vitest';

import { scrollToCursorKeys } from './terminalScroll';

const UP = '\x1b[A';
const DOWN = '\x1b[B';

describe('scrollToCursorKeys', () => {
  it('emits nothing until the drag crosses a full row, carrying the remainder', () => {
    const result = scrollToCursorKeys(10, 18);
    expect(result.data).toBe('');
    expect(result.remainderPx).toBe(10);
  });

  it('maps an upward drag to DOWN arrows (natural scrolling advances the list)', () => {
    const result = scrollToCursorKeys(40, 18);
    expect(result.data).toBe(DOWN.repeat(2));
    // 40 - 2*18 = 4 left over for the next move.
    expect(result.remainderPx).toBe(4);
  });

  it('maps a downward drag to UP arrows', () => {
    const result = scrollToCursorKeys(-40, 18);
    expect(result.data).toBe(UP.repeat(2));
    expect(result.remainderPx).toBe(-4);
  });

  it('caps the presses from a single fling', () => {
    const result = scrollToCursorKeys(18 * 1000, 18);
    expect(result.data).toBe(DOWN.repeat(40));
  });

  it('is inert for a non-positive or non-finite row height', () => {
    expect(scrollToCursorKeys(100, 0)).toEqual({ data: '', remainderPx: 0 });
    expect(scrollToCursorKeys(100, Number.NaN)).toEqual({ data: '', remainderPx: 0 });
    expect(scrollToCursorKeys(Number.POSITIVE_INFINITY, 18)).toEqual({ data: '', remainderPx: 0 });
  });
});
