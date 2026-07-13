import type { Prisma } from '@prisma/client';
import type { FastifyRequest } from 'fastify';

import type { DatabaseClient } from '../prisma.js';

type AuditDatabase = Pick<DatabaseClient, 'auditEvent'>;

export interface AuditInput {
  action: string;
  userId?: string;
  deviceId?: string;
  metadata?: Prisma.InputJsonValue;
}

export class AuditService {
  constructor(private readonly database: DatabaseClient) {}

  async record(
    request: FastifyRequest,
    input: AuditInput,
    database: AuditDatabase = this.database,
  ): Promise<void> {
    const data: Prisma.AuditEventUncheckedCreateInput = {
      action: input.action,
      ipAddress: request.ip.slice(0, 100),
      ...(request.headers['user-agent'] === undefined
        ? {}
        : { userAgent: request.headers['user-agent'].slice(0, 500) }),
      ...(input.userId === undefined ? {} : { userId: input.userId }),
      ...(input.deviceId === undefined ? {} : { deviceId: input.deviceId }),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    };
    await database.auditEvent.create({
      data,
    });
  }
}
