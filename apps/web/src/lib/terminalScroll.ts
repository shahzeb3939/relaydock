// A fullscreen TUI (Claude Code's `tui:fullscreen`) runs in xterm's alternate
// screen buffer, which has no scrollback. On a laptop the mouse wheel is
// translated into cursor-key presses so it can move the app's selection/list; a
// touch swipe produces no wheel events, so a phone can neither scroll nor
// navigate. This converts an accumulated vertical drag into the same cursor-key
// presses, giving touch devices the wheel's behaviour.

const CURSOR_UP = '\x1b[A';
const CURSOR_DOWN = '\x1b[B';

// A single fling shouldn't fire hundreds of arrows; cap the presses emitted per
// touchmove so a fast swipe stays proportional without runaway.
const MAX_STEPS_PER_MOVE = 40;

export interface CursorKeyScroll {
  // The cursor-key sequence to send to the PTY (empty when the drag hasn't yet
  // crossed a full row).
  data: string;
  // Leftover sub-row drag distance to carry into the next touchmove, so slow
  // drags still accumulate to a step instead of being discarded.
  remainderPx: number;
}

// `upwardPx` is the finger's cumulative displacement, positive when it moves UP
// the screen. Moving up scrolls the view down (advances a list), matching
// natural scrolling, so positive maps to the DOWN arrow. `rowHeightPx` is the
// rendered height of one terminal row.
export function scrollToCursorKeys(upwardPx: number, rowHeightPx: number): CursorKeyScroll {
  if (!Number.isFinite(upwardPx) || !Number.isFinite(rowHeightPx) || rowHeightPx <= 0) {
    return { data: '', remainderPx: 0 };
  }
  const steps = Math.trunc(upwardPx / rowHeightPx);
  if (steps === 0) return { data: '', remainderPx: upwardPx };
  const key = steps > 0 ? CURSOR_DOWN : CURSOR_UP;
  const count = Math.min(Math.abs(steps), MAX_STEPS_PER_MOVE);
  return { data: key.repeat(count), remainderPx: upwardPx - steps * rowHeightPx };
}
