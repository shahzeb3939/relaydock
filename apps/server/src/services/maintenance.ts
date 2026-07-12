import type { FastifyBaseLogger } from 'fastify';

import type { ServerEnvironment } from '../env.js';
import type { DatabaseClient } from '../prisma.js';
import type { ConnectionHub } from './connections.js';

export class MaintenanceService {
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private cleanupTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly database: DatabaseClient,
    private readonly connections: ConnectionHub,
    private readonly environment: ServerEnvironment,
    private readonly logger: FastifyBaseLogger,
  ) {}

  async start(): Promise<void> {
    await this.database.device.updateMany({
      where: { status: 'online' },
      data: { status: 'offline' },
    });
    this.heartbeatTimer = setInterval(() => this.expireStaleConnections(), 5_000);
    this.heartbeatTimer.unref();
    this.cleanupTimer = setInterval(
      () => {
        void this.cleanup().catch((error: unknown) =>
          this.logger.error({ err: error }, 'retention cleanup failed'),
        );
      },
      6 * 60 * 60 * 1000,
    );
    this.cleanupTimer.unref();
  }

  stop(): void {
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    if (this.cleanupTimer !== undefined) clearInterval(this.cleanupTimer);
  }

  async cleanup(now = new Date()): Promise<void> {
    const jobCutoff = new Date(now.getTime() - this.environment.JOB_RETENTION_DAYS * 86_400_000);
    const housekeepingCutoff = new Date(now.getTime() - 86_400_000);
    const [jobs, sessions, pairingCodes] = await this.database.$transaction([
      this.database.job.deleteMany({
        where: {
          status: { in: ['completed', 'failed', 'cancelled'] },
          finishedAt: { lt: jobCutoff },
        },
      }),
      this.database.session.deleteMany({
        where: {
          OR: [{ expiresAt: { lt: now } }, { revokedAt: { not: null, lt: housekeepingCutoff } }],
        },
      }),
      this.database.pairingCode.deleteMany({
        where: {
          OR: [{ expiresAt: { lt: now } }, { usedAt: { not: null, lt: housekeepingCutoff } }],
        },
      }),
    ]);
    this.logger.info(
      {
        deletedJobs: jobs.count,
        deletedSessions: sessions.count,
        deletedPairingCodes: pairingCodes.count,
      },
      'retention cleanup completed',
    );
  }

  private expireStaleConnections(): void {
    for (const connection of this.connections.staleAgents(this.environment.OFFLINE_AFTER_MS)) {
      this.logger.warn({ deviceId: connection.deviceId }, 'agent heartbeat timed out');
      connection.socket.terminate();
    }
  }
}
