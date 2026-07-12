import type { JobStatus } from '@relaydock/protocol';

const transitions: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  queued: ['dispatched', 'failed', 'cancelled'],
  dispatched: ['running', 'failed', 'cancelled', 'disconnected'],
  running: ['waiting_for_input', 'completed', 'failed', 'cancelled', 'disconnected'],
  waiting_for_input: ['running', 'completed', 'failed', 'cancelled', 'disconnected'],
  disconnected: ['running', 'waiting_for_input', 'completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

export function canTransitionJob(from: JobStatus, to: JobStatus): boolean {
  return from === to || transitions[from].includes(to);
}

export function isTerminalJobStatus(status: JobStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

export function durationMilliseconds(startedAt: Date | string, finishedAt: Date | string): number {
  return Math.max(0, new Date(finishedAt).getTime() - new Date(startedAt).getTime());
}
