import type { Job } from '@prisma/client';
import type {
  JobStatus,
  OutputStream,
  ServerToAgentMessage,
  ServerToClientMessage,
} from '@relaydock/protocol';
import { createMessage } from '@relaydock/protocol';
import { canTransitionJob, isTerminalJobStatus } from '@relaydock/shared';

import { AppError } from '../lib/errors.js';
import { serializeOutputChunk } from '../lib/serializers.js';
import type { DatabaseClient } from '../prisma.js';
import type { ConnectionHub } from './connections.js';

export interface IncomingOutputChunk {
  sequence: number;
  stream: OutputStream;
  data: string;
}

interface PersistedOutputResult {
  chunks: IncomingOutputChunk[];
  truncated: boolean;
}

export class JobService {
  private readonly outputQueues = new Map<string, Promise<void>>();

  constructor(
    private readonly database: DatabaseClient,
    private readonly connections: ConnectionHub,
    private readonly maximumOutputBytes: number,
  ) {}

  async transitionFromAgent(
    deviceId: string,
    jobId: string,
    target: JobStatus,
    options: { detail?: string; exitCode?: number } = {},
  ): Promise<Job | null> {
    const current = await this.database.job.findUnique({ where: { id: jobId } });
    if (current === null || current.deviceId !== deviceId) return null;
    if (isTerminalJobStatus(current.status)) return current;
    if (!canTransitionJob(current.status, target)) {
      throw new AppError(
        409,
        'JOB_TRANSITION_INVALID',
        `Cannot transition job from ${current.status} to ${target}.`,
      );
    }
    const now = new Date();
    const terminal = isTerminalJobStatus(target);
    const updated = await this.database.job.update({
      where: { id: jobId },
      data: {
        status: target,
        ...(options.detail === undefined ? {} : { statusDetail: options.detail }),
        ...(options.exitCode === undefined ? {} : { exitCode: options.exitCode }),
        ...(target === 'running' && current.startedAt === null ? { startedAt: now } : {}),
        ...(terminal ? { finishedAt: now } : {}),
      },
    });
    const message: ServerToClientMessage = createMessage('job.status', {
      jobId,
      status: updated.status,
      exitCode: updated.exitCode,
    });
    await this.connections.broadcastJob(updated.userId, jobId, message);
    return updated;
  }

  async persistOutput(
    deviceId: string,
    jobId: string,
    chunks: readonly IncomingOutputChunk[],
  ): Promise<PersistedOutputResult> {
    let result: PersistedOutputResult = { chunks: [], truncated: false };
    await this.serializeOutput(jobId, async () => {
      const job = await this.database.job.findUnique({
        where: { id: jobId },
        select: { deviceId: true, userId: true, outputTruncated: true, retainedOutputBytes: true },
      });
      if (job === null || job.deviceId !== deviceId || chunks.length === 0) return;
      const sequences = [...new Set(chunks.map((chunk) => chunk.sequence))];
      const existing = await this.database.jobOutputChunk.findMany({
        where: { jobId, sequence: { in: sequences } },
        select: { sequence: true },
      });
      const existingSequences = new Set(existing.map((chunk) => chunk.sequence));
      const newChunks = chunks.filter((chunk) => !existingSequences.has(chunk.sequence));
      if (newChunks.length === 0) return;

      const inserts = newChunks.map((chunk) => ({
        jobId,
        sequence: chunk.sequence,
        stream: chunk.stream,
        data: chunk.data,
        byteLength: Buffer.byteLength(chunk.data, 'utf8'),
      }));
      const addedBytes = inserts.reduce((sum, chunk) => sum + chunk.byteLength, 0);

      const retention = await this.database.$transaction(async (transaction) => {
        await transaction.jobOutputChunk.createMany({ data: inserts, skipDuplicates: true });

        // Enforce the retention cap incrementally. `retainedOutputBytes` is a running
        // total kept on the Job row, so we no longer re-read the job's entire chunk
        // index on every chunk — that was O(n) reads per chunk and O(n^2) over the
        // life of a streaming job, a dominant source of database read traffic. We only
        // read the oldest chunks when eviction is actually required, and only as many
        // as needed to reclaim the overflow.
        const projectedBytes = job.retainedOutputBytes + addedBytes;
        const removedSequences = new Set<number>();
        let removedBytes = 0;
        if (projectedBytes > this.maximumOutputBytes) {
          const bytesToReclaim = projectedBytes - this.maximumOutputBytes;
          // Evicting reclaims roughly as many chunks as were just added, so read the
          // oldest rows in pages sized to that, not to the (potentially huge) retained
          // count. The cursor loop still covers the rare case where more must go.
          const pageSize = Math.min(Math.max(newChunks.length * 2, 32), 1024);
          let cursorSequence = -1;
          while (removedBytes < bytesToReclaim) {
            const oldest = await transaction.jobOutputChunk.findMany({
              where: { jobId, sequence: { gt: cursorSequence } },
              select: { id: true, sequence: true, byteLength: true },
              orderBy: { sequence: 'asc' },
              take: pageSize,
            });
            if (oldest.length === 0) break;
            const removeIds: string[] = [];
            for (const chunk of oldest) {
              removeIds.push(chunk.id);
              removedSequences.add(chunk.sequence);
              removedBytes += chunk.byteLength;
              cursorSequence = chunk.sequence;
              if (removedBytes >= bytesToReclaim) break;
            }
            await transaction.jobOutputChunk.deleteMany({ where: { id: { in: removeIds } } });
          }
        }

        const truncated = job.outputTruncated || removedSequences.size > 0;
        await transaction.job.update({
          where: { id: jobId },
          data: { retainedOutputBytes: projectedBytes - removedBytes, outputTruncated: truncated },
        });
        return { removedSequences, truncated };
      });

      const retainedNewChunks = newChunks.filter(
        (chunk) => !retention.removedSequences.has(chunk.sequence),
      );
      for (const chunk of retainedNewChunks) {
        const message: ServerToClientMessage = createMessage('job.output', {
          jobId,
          sequence: chunk.sequence,
          stream: chunk.stream,
          data: chunk.data,
        });
        await this.connections.broadcastJob(job.userId, jobId, message);
      }
      result = { chunks: retainedNewChunks, truncated: retention.truncated };
    });
    return result;
  }

  async replay(userId: string, jobId: string, afterSequence: number, limit = 1000) {
    const job = await this.database.job.findFirst({
      where: { id: jobId, userId },
      select: { outputTruncated: true },
    });
    if (job === null) throw new AppError(404, 'JOB_NOT_FOUND', 'Job not found.');
    const chunks = await this.database.jobOutputChunk.findMany({
      where: { jobId, sequence: { gt: afterSequence } },
      orderBy: { sequence: 'asc' },
      take: limit,
    });
    if (!job.outputTruncated) return chunks.map(serializeOutputChunk);

    const earliest = await this.database.jobOutputChunk.findFirst({
      where: { jobId },
      select: { sequence: true },
      orderBy: { sequence: 'asc' },
    });
    const noticeSequence = Math.max(0, (earliest?.sequence ?? 1) - 1);
    const includesGap = afterSequence < noticeSequence;
    return [
      ...(includesGap
        ? [
            {
              sequence: noticeSequence,
              stream: 'system' as const,
              data: '[Earlier output was removed by the server retention limit.]\r\n',
            },
          ]
        : []),
      ...chunks.map(serializeOutputChunk),
    ];
  }

  async latestSequence(jobId: string): Promise<number> {
    const latest = await this.database.jobOutputChunk.findFirst({
      where: { jobId },
      select: { sequence: true },
      orderBy: { sequence: 'desc' },
    });
    return latest?.sequence ?? -1;
  }

  async requestCancellation(userId: string, jobId: string): Promise<Job> {
    const job = await this.database.job.findFirst({ where: { id: jobId, userId } });
    if (job === null) throw new AppError(404, 'JOB_NOT_FOUND', 'Job not found.');
    if (isTerminalJobStatus(job.status)) return job;
    if (job.status === 'queued') {
      const cancelled = await this.database.job.update({
        where: { id: jobId },
        data: {
          status: 'cancelled',
          finishedAt: new Date(),
          statusDetail: 'Cancelled before start.',
        },
      });
      const statusMessage: ServerToClientMessage = createMessage('job.status', {
        jobId,
        status: 'cancelled',
        exitCode: cancelled.exitCode,
      });
      await this.connections.broadcastJob(userId, jobId, statusMessage);
      return cancelled;
    }
    const message: ServerToAgentMessage = createMessage('job.cancel', { jobId });
    if (!(await this.connections.sendToAgent(job.deviceId, message))) {
      throw new AppError(
        409,
        'DEVICE_OFFLINE',
        'The device is offline; RelayDock cannot confirm process cancellation.',
      );
    }
    return this.database.job.update({
      where: { id: jobId },
      data: { statusDetail: 'Cancellation requested.' },
    });
  }

  async forwardInput(
    userId: string,
    jobId: string,
    inputSequence: number,
    data: string,
  ): Promise<void> {
    const job = await this.database.job.findFirst({ where: { id: jobId, userId } });
    if (job === null) throw new AppError(404, 'JOB_NOT_FOUND', 'Job not found.');
    if (!job.interactive || isTerminalJobStatus(job.status)) {
      throw new AppError(409, 'JOB_NOT_INTERACTIVE', 'This job cannot accept terminal input.');
    }
    const message: ServerToAgentMessage = createMessage('job.input', {
      jobId,
      inputSequence,
      data,
    });
    if (!(await this.connections.sendToAgent(job.deviceId, message))) {
      throw new AppError(409, 'DEVICE_OFFLINE', 'The device is offline.');
    }
  }

  async forwardResize(userId: string, jobId: string, columns: number, rows: number): Promise<void> {
    const job = await this.database.job.findFirst({ where: { id: jobId, userId } });
    if (job === null) throw new AppError(404, 'JOB_NOT_FOUND', 'Job not found.');
    if (!job.interactive || isTerminalJobStatus(job.status)) return;
    const message: ServerToAgentMessage = createMessage('job.resize', { jobId, columns, rows });
    if (!(await this.connections.sendToAgent(job.deviceId, message))) {
      throw new AppError(409, 'DEVICE_OFFLINE', 'The device is offline.');
    }
  }

  private async serializeOutput(jobId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.outputQueues.get(jobId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.outputQueues.set(jobId, current);
    try {
      await current;
    } finally {
      if (this.outputQueues.get(jobId) === current) this.outputQueues.delete(jobId);
    }
  }
}
