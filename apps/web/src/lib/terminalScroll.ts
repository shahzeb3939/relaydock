// A fullscreen TUI (Claude Code's `tui:fullscreen`) runs in xterm's alternate
// screen buffer, and modern TUIs enable mouse tracking. On a laptop the mouse
// WHEEL drives them — scrolling the app's own history or moving a selection; a
// touch swipe emits no wheel events, so a phone can neither scroll nor navigate.
// We bridge the gap by turning an accumulated swipe into synthetic wheel
// *notches* and feeding them back into xterm, which then emits exactly what a
// real wheel would (a mouse-wheel report when the app tracks the mouse, cursor
// keys otherwise). This computes how many one-row notches a drag has crossed.

// A single fling shouldn't fire hundreds of notches; cap the notches emitted per
// touchmove so a fast swipe stays proportional without runaway.
const MAX_STEPS_PER_MOVE = 40;

export interface WheelSteps {
  // Signed count of one-row wheel notches the drag has crossed (0 when it hasn't
  // yet crossed a full row). Positive when the finger moved UP the screen —
  // natural scrolling then reveals newer content, i.e. a wheel-DOWN notch
  // (positive deltaY) — negative when it moved down.
  steps: number;
  // Leftover sub-row drag distance to carry into the next touchmove, so slow
  // drags still accumulate to a notch instead of being discarded.
  remainderPx: number;
}

// `upwardPx` is the finger's cumulative displacement, positive when it moves UP
// the screen. `rowHeightPx` is the rendered height of one terminal row, which we
// treat as one notch of travel.
export function wheelStepsFromDrag(upwardPx: number, rowHeightPx: number): WheelSteps {
  if (!Number.isFinite(upwardPx) || !Number.isFinite(rowHeightPx) || rowHeightPx <= 0) {
    return { steps: 0, remainderPx: 0 };
  }
  const raw = Math.trunc(upwardPx / rowHeightPx);
  if (raw === 0) return { steps: 0, remainderPx: upwardPx };
  // Cap the emitted notches, but derive the carried remainder from the uncapped
  // travel so the excess of a hard fling is discarded rather than replayed on the
  // next move.
  const steps = Math.sign(raw) * Math.min(Math.abs(raw), MAX_STEPS_PER_MOVE);
  return { steps, remainderPx: upwardPx - raw * rowHeightPx };
}
