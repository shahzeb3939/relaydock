import path from 'node:path';

import { Prisma } from '@prisma/client';
import { createMessage } from '@relaydock/protocol';
import type { ServerToAgentMessage, ServerToClientMessage } from '@relaydock/protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { ServerEnvironment } from '../env.js';
import { createOpaqueToken, createPairingCode, hashOpaqueToken } from '../lib/crypto.js';
import { environmentNameSchema, isPairingCodeUsable, normalizePairingCode } from '../lib/domain.js';
import { AppError } from '../lib/errors.js';
import { serializeDevice, serializeJob, serializeRepository } from '../lib/serializers.js';
import type { DatabaseClient } from '../prisma.js';
import type { AuditService } from '../services/audit.js';
import type { ConnectionHub, RepositoryValidationBroker } from '../services/connections.js';

const idParametersSchema = z.object({ deviceId: z.string().uuid() });
const pairingInputSchema = z.object({
  code: z.string().min(8).max(20),
  name: z.string().trim().min(1).max(100),
  platform: z.string().trim().min(1).max(50),
  architecture: z.string().trim().min(1).max(50),
  agentVersion: z.string().trim().min(1).max(50),
});
const repositoryInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  absolutePath: z.string().trim().min(1).max(4096),
  description: z.string().trim().max(1000).optional(),
  allowCustomCommands: z.boolean().default(false),
  shell: z.string().trim().min(1).max(4096).default('/bin/zsh'),
  shellArgs: z.array(z.string().max(1000)).max(20).default(['-lc']),
  inheritedEnvironment: z
    .array(environmentNameSchema)
    .max(100)
    .default(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TERM', 'LANG']),
});

export interface DeviceRouteDependencies {
  database: DatabaseClient;
  environment: ServerEnvironment;
  audit: AuditService;
  connections: ConnectionHub;
  validations: RepositoryValidationBroker;
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  requireCsrf: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

function userId(request: FastifyRequest): string {
  if (request.auth === null) throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'Sign in.');
  return request.auth.user.id;
}

function pathLooksAbsolute(value: string): boolean {
  return path.posix.isAbsolute(value) || path.win32.isAbsolute(value);
}

export function registerDeviceRoutes(
  app: FastifyInstance,
  dependencies: DeviceRouteDependencies,
): void {
  const { database, environment, audit, connections, validations, requireAuth, requireCsrf } =
    dependencies;

  app.post(
    '/api/devices/pairing-codes',
    { preHandler: [requireAuth, requireCsrf] },
    async (request, reply) => {
      const code = createPairingCode();
      const expiresAt = new Date(Date.now() + environment.PAIRING_CODE_TTL_MINUTES * 60_000);
      await database.pairingCode.create({
        data: {
          userId: userId(request),
          codeHash: hashOpaqueToken(code, environment.SESSION_SECRET),
          expiresAt,
        },
      });
      return reply.status(201).send({ code, expiresAt: expiresAt.toISOString() });
    },
  );

  app.post(
    '/api/devices/pair',
    { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } },
    async (request, reply) => {
      const input = pairingInputSchema.parse(request.body);
      const code = normalizePairingCode(input.code);
      const pairingCode =
        code === ''
          ? null
          : await database.pairingCode.findUnique({
              where: { codeHash: hashOpaqueToken(code, environment.SESSION_SECRET) },
            });
      if (pairingCode === null || !isPairingCodeUsable(pairingCode)) {
        throw new AppError(400, 'PAIRING_CODE_INVALID', 'The pairing code is invalid or expired.');
      }

      const credential = createOpaqueToken('rdc');
      const result = await database.$transaction(async (transaction) => {
        const claimed = await transaction.pairingCode.updateMany({
          where: { id: pairingCode.id, usedAt: null, expiresAt: { gt: new Date() } },
          data: { usedAt: new Date() },
        });
        if (claimed.count !== 1) {
          throw new AppError(400, 'PAIRING_CODE_INVALID', 'The pairing code was already used.');
        }
        const device = await transaction.device.create({
          data: {
            userId: pairingCode.userId,
            name: input.name,
            platform: input.platform,
            architecture: input.architecture,
            agentVersion: input.agentVersion,
          },
        });
        await transaction.deviceCredential.create({
          data: {
            deviceId: device.id,
            credentialHash: hashOpaqueToken(credential, environment.CREDENTIAL_SECRET),
          },
        });
        return device;
      });
      await audit.record(request, {
        action: 'device.paired',
        userId: pairingCode.userId,
        deviceId: result.id,
      });
      return reply.status(201).send({ deviceId: result.id, credential });
    },
  );

  app.get('/api/devices', { preHandler: requireAuth }, async (request) => {
    const devices = await database.device.findMany({
      where: { userId: userId(request) },
      include: { _count: { select: { repositories: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return { devices: devices.map(serializeDevice) };
  });

  app.get('/api/devices/:deviceId', { preHandler: requireAuth }, async (request) => {
    const { deviceId } = idParametersSchema.parse(request.params);
    const device = await database.device.findFirst({
      where: { id: deviceId, userId: userId(request) },
      include: { _count: { select: { repositories: true } } },
    });
    if (device === null) throw new AppError(404, 'DEVICE_NOT_FOUND', 'Device not found.');
    const [repositories, recentJobs] = await Promise.all([
      database.repository.findMany({ where: { deviceId }, orderBy: { name: 'asc' } }),
      database.job.findMany({
        where: { deviceId, userId: userId(request) },
        include: { repository: { select: { id: true, name: true } } },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
    ]);
    return {
      device: serializeDevice(device),
      repositories: repositories.map(serializeRepository),
      recentJobs: recentJobs.map(serializeJob),
    };
  });

  app.delete(
    '/api/devices/:deviceId',
    { preHandler: [requireAuth, requireCsrf] },
    async (request, reply) => {
      const { deviceId } = idParametersSchema.parse(request.params);
      const ownerId = userId(request);
      const device = await database.device.findFirst({ where: { id: deviceId, userId: ownerId } });
      if (device === null) throw new AppError(404, 'DEVICE_NOT_FOUND', 'Device not found.');
      const affectedJobs = await database.job.findMany({
        where: {
          deviceId,
          status: { in: ['queued', 'dispatched', 'running', 'waiting_for_input'] },
        },
      });
      const cancellationResults = await Promise.allSettled(
        affectedJobs.map((job) => {
          const cancel: ServerToAgentMessage = createMessage('job.cancel', { jobId: job.id });
          return connections.sendToAgent(deviceId, cancel);
        }),
      );
      for (const result of cancellationResults) {
        if (result.status === 'rejected') {
          request.log.warn(
            { err: result.reason, deviceId },
            'failed to request job cancellation during device revocation',
          );
        }
      }
      await database.$transaction(async (transaction) => {
        await transaction.device.update({ where: { id: deviceId }, data: { status: 'revoked' } });
        await transaction.deviceCredential.updateMany({
          where: { deviceId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        await transaction.job.updateMany({
          where: {
            deviceId,
            status: { in: ['queued', 'dispatched', 'running', 'waiting_for_input'] },
          },
          data: { status: 'disconnected', statusDetail: 'Device was revoked.' },
        });
        await audit.record(
          request,
          {
            action: 'device.revoked',
            userId: ownerId,
            deviceId,
            metadata: { deviceId, deviceName: device.name },
          },
          transaction,
        );
      });
      const now = new Date();
      const revoked: ServerToClientMessage = createMessage('device.status', {
        deviceId,
        status: 'revoked',
        lastSeenAt: (device.lastSeenAt ?? now).toISOString(),
      });
      const notificationResults = await Promise.allSettled([
        connections.broadcastDevice(ownerId, revoked),
        ...affectedJobs.map((job) => {
          const disconnected: ServerToClientMessage = createMessage('job.status', {
            jobId: job.id,
            status: 'disconnected',
            exitCode: job.exitCode,
          });
          return connections.broadcastJob(ownerId, job.id, disconnected);
        }),
        connections.closeDevice(deviceId, 'device revoked'),
        validations.cancelForDevice(deviceId),
      ]);
      for (const result of notificationResults) {
        if (result.status === 'rejected') {
          request.log.warn({ err: result.reason, deviceId }, 'device revocation follow-up failed');
        }
      }
      return reply.status(204).send();
    },
  );

  app.delete(
    '/api/devices/:deviceId/permanent',
    { preHandler: [requireAuth, requireCsrf] },
    async (request, reply) => {
      const { deviceId } = idParametersSchema.parse(request.params);
      const ownerId = userId(request);
      await database.$transaction(async (transaction) => {
        // Referencing inserts take a key-share lock in PostgreSQL. Locking the parent first makes
        // concurrent job/repository creation finish before this purge or fail after the device is
        // gone, rather than slipping between the child deletes and the restricted parent delete.
        const [device] = await transaction.$queryRaw<
          Array<{ id: string; name: string; status: 'online' | 'offline' | 'revoked' }>
        >`SELECT "id", "name", "status"::text AS "status"
          FROM "Device"
          WHERE "id" = ${deviceId}::uuid AND "userId" = ${ownerId}::uuid
          FOR UPDATE`;
        if (device === undefined) throw new AppError(404, 'DEVICE_NOT_FOUND', 'Device not found.');
        if (device.status !== 'revoked') {
          throw new AppError(
            409,
            'DEVICE_NOT_REVOKED',
            'Revoke the device before deleting it permanently.',
          );
        }

        await transaction.job.deleteMany({ where: { deviceId } });
        await transaction.repository.deleteMany({ where: { deviceId } });
        await transaction.device.delete({ where: { id: deviceId } });
        await audit.record(
          request,
          {
            action: 'device.deleted',
            userId: ownerId,
            metadata: { deviceId, deviceName: device.name },
          },
          transaction,
        );
      });

      const cleanupResults = await Promise.allSettled([
        connections.closeDevice(deviceId, 'device deleted'),
        validations.cancelForDevice(deviceId),
      ]);
      for (const result of cleanupResults) {
        if (result.status === 'rejected') {
          request.log.warn({ err: result.reason, deviceId }, 'device deletion follow-up failed');
        }
      }

      return reply.status(204).send();
    },
  );

  app.get('/api/devices/:deviceId/repositories', { preHandler: requireAuth }, async (request) => {
    const { deviceId } = idParametersSchema.parse(request.params);
    const ownerId = userId(request);
    const device = await database.device.findFirst({ where: { id: deviceId, userId: ownerId } });
    if (device === null) throw new AppError(404, 'DEVICE_NOT_FOUND', 'Device not found.');
    const repositories = await database.repository.findMany({
      where: { deviceId },
      orderBy: { name: 'asc' },
    });
    return { repositories: repositories.map(serializeRepository) };
  });

  app.post(
    '/api/devices/:deviceId/repositories',
    { preHandler: [requireAuth, requireCsrf] },
    async (request, reply) => {
      const { deviceId } = idParametersSchema.parse(request.params);
      const input = repositoryInputSchema.parse(request.body);
      if (!pathLooksAbsolute(input.absolutePath)) {
        throw new AppError(400, 'PATH_NOT_ABSOLUTE', 'Repository path must be absolute.');
      }
      const ownerId = userId(request);
      const device = await database.device.findFirst({ where: { id: deviceId, userId: ownerId } });
      if (device === null) throw new AppError(404, 'DEVICE_NOT_FOUND', 'Device not found.');
      if (device.status === 'revoked') {
        throw new AppError(409, 'DEVICE_REVOKED', 'A revoked device cannot register repositories.');
      }
      if (!(await connections.isAgentOnline(deviceId))) {
        throw new AppError(409, 'DEVICE_OFFLINE', 'The device must be online to validate a path.');
      }

      let repository;
      try {
        repository = await database.repository.create({
          data: {
            deviceId,
            name: input.name,
            absolutePath: input.absolutePath,
            description: input.description ?? null,
            allowCustomCommands: input.allowCustomCommands,
            shell: input.shell,
            shellArgs: input.shellArgs,
            inheritedEnvironment: input.inheritedEnvironment,
            enabled: false,
          },
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw new AppError(409, 'REPOSITORY_EXISTS', 'That path is already registered.');
        }
        throw error;
      }

      try {
        const validation = await validations.request(deviceId, repository.id, input.absolutePath);
        if (!validation.valid || validation.canonicalPath === undefined) {
          throw new AppError(
            422,
            'REPOSITORY_INVALID',
            validation.error ?? 'The agent could not validate this repository path.',
          );
        }
        repository = await database.repository.update({
          where: { id: repository.id },
          data: {
            absolutePath: validation.canonicalPath,
            repositoryRoot: validation.repositoryRoot ?? validation.canonicalPath,
            isGitRepository: validation.isGitRepository,
            branch: validation.branch ?? null,
            enabled: true,
          },
        });
      } catch (error) {
        await database.repository.deleteMany({ where: { id: repository.id, enabled: false } });
        throw error;
      }
      await audit.record(request, {
        action: 'repository.created',
        userId: ownerId,
        deviceId,
        metadata: { repositoryId: repository.id },
      });
      return reply.status(201).send({ repository: serializeRepository(repository) });
    },
  );
}
