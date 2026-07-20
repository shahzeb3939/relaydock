import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DatabaseClient } from '../prisma.js';
import type { ConnectionHub } from './connections.js';
import { JobService } from './jobs.js';

const jobId = '00000000-0000-4000-8000-000000000001';
const deviceId = '00000000-0000-4000-8000-000000000002';
const userId = '00000000-0000-4000-8000-000000000003';

function createHarness() {
  const job = {
    deviceId,
    userId,
    outputTruncated: false,
    retainedOutputBytes: 0,
  };
  const inserted: Array<{ jobId: string; sequence: number; stream: string; data: string }> = [];
  const transaction = {
    jobOutputChunk: {
      createMany: vi.fn(async ({ data }: { data: typeof inserted }) => {
        inserted.push(...data);
        return { count: data.length };
      }),
      findMany: vi.fn(async () => []),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    job: { update: vi.fn(async () => job) },
  };
  const database = {
    job: { findUnique: vi.fn(async () => job) },
    jobOutputChunk: { findMany: vi.fn(async () => [] as Array<{ sequence: number }>) },
    $transaction: vi.fn(async (callback: (tx: typeof transaction) => Promise<unknown>) =>
      callback(transaction),
    ),
  } as unknown as DatabaseClient;

  const broadcasts: Array<{ userId: string; jobId: string; type: string; sequence?: number }> = [];
  const connections = {
    broadcastJob: vi.fn(
      async (
        broadcastUserId: string,
        broadcastJobId: string,
        message: { type: string; payload: { sequence?: number } },
      ) => {
        broadcasts.push({
          userId: broadcastUserId,
          jobId: broadcastJobId,
          type: message.type,
          sequence: message.payload.sequence,
        });
      },
    ),
  } as unknown as ConnectionHub;

  const jobs = new JobService(database, connections, 1_000_000, undefined);
  return { jobs, database, connections, broadcasts, inserted };
}

describe('JobService live output', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('relays a live chunk to viewers without touching the database', () => {
    const { jobs, database, connections, broadcasts } = createHarness();

    jobs.relayOutput(userId, deviceId, jobId, { sequence: 0, stream: 'stdout', data: 'hello' });

    // The viewer sees the chunk immediately...
    expect(connections.broadcastJob).toHaveBeenCalledTimes(1);
    expect(broadcasts[0]).toMatchObject({ userId, jobId, type: 'job.output', sequence: 0 });
    // ...and no database round-trip gated that broadcast.
    expect(database.job.findUnique).not.toHaveBeenCalled();
  });

  it('persists relayed chunks in the background without re-broadcasting', async () => {
    const { jobs, database, connections, inserted } = createHarness();

    jobs.relayOutput(userId, deviceId, jobId, { sequence: 0, stream: 'stdout', data: 'a' });
    jobs.relayOutput(userId, deviceId, jobId, { sequence: 1, stream: 'stdout', data: 'b' });
    expect(inserted).toHaveLength(0);

    await jobs.flushOutput(jobId);

    expect(database.job.findUnique).toHaveBeenCalledTimes(1);
    expect(inserted).toEqual([
      expect.objectContaining({ jobId, sequence: 0, data: 'a' }),
      expect.objectContaining({ jobId, sequence: 1, data: 'b' }),
    ]);
    // The flush is persistence-only: each chunk was broadcast exactly once, on relay.
    expect(connections.broadcastJob).toHaveBeenCalledTimes(2);
  });

  it('flushes buffered output automatically on the background timer', async () => {
    vi.useFakeTimers();
    const { jobs, inserted } = createHarness();

    jobs.relayOutput(userId, deviceId, jobId, { sequence: 0, stream: 'stdout', data: 'x' });
    expect(inserted).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(200);

    expect(inserted).toEqual([expect.objectContaining({ sequence: 0, data: 'x' })]);
  });

  it('persistOutput (reconnect buffer sync) both persists and broadcasts', async () => {
    const { jobs, connections, inserted } = createHarness();

    const result = await jobs.persistOutput(deviceId, jobId, [
      { sequence: 9, stream: 'stdout', data: 'synced' },
    ]);

    expect(inserted).toEqual([expect.objectContaining({ sequence: 9, data: 'synced' })]);
    expect(result.chunks).toHaveLength(1);
    expect(connections.broadcastJob).toHaveBeenCalledTimes(1);
  });
});
