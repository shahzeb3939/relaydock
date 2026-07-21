import { describe, expect, it } from 'vitest';

import { wheelStepsFromDrag } from './terminalScroll';

describe('wheelStepsFromDrag', () => {
  it('emits no notch until the drag crosses a full row, carrying the remainder', () => {
    const result = wheelStepsFromDrag(10, 18);
    expect(result.steps).toBe(0);
    expect(result.remainderPx).toBe(10);
  });

  it('maps an upward drag to positive (wheel-down) notches — natural scrolling reveals newer content', () => {
    const result = wheelStepsFromDrag(40, 18);
    expect(result.steps).toBe(2);
    // 40 - 2*18 = 4 left over for the next move.
    expect(result.remainderPx).toBe(4);
  });

  it('maps a downward drag to negative (wheel-up) notches', () => {
    const result = wheelStepsFromDrag(-40, 18);
    expect(result.steps).toBe(-2);
    expect(result.remainderPx).toBe(-4);
  });

  it('caps the notches from a single fling and discards the excess travel', () => {
    const result = wheelStepsFromDrag(18 * 1000, 18);
    expect(result.steps).toBe(40);
    // The remainder is derived from the uncapped travel, so nothing beyond the
    // cap is replayed on the next move.
    expect(result.remainderPx).toBe(0);
  });

  it('is inert for a non-positive or non-finite row height', () => {
    expect(wheelStepsFromDrag(100, 0)).toEqual({ steps: 0, remainderPx: 0 });
    expect(wheelStepsFromDrag(100, Number.NaN)).toEqual({ steps: 0, remainderPx: 0 });
    expect(wheelStepsFromDrag(Number.POSITIVE_INFINITY, 18)).toEqual({ steps: 0, remainderPx: 0 });
  });
});
