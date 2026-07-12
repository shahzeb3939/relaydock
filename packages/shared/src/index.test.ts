import { describe, expect, it } from 'vitest';

import { canTransitionJob, isTerminalJobStatus } from './index.js';

describe('job state transitions', () => {
  it('allows the expected dispatch lifecycle', () => {
    expect(canTransitionJob('queued', 'dispatched')).toBe(true);
    expect(canTransitionJob('dispatched', 'running')).toBe(true);
    expect(canTransitionJob('running', 'completed')).toBe(true);
  });

  it('does not reopen a terminal job', () => {
    expect(canTransitionJob('completed', 'running')).toBe(false);
    expect(isTerminalJobStatus('cancelled')).toBe(true);
  });
});
