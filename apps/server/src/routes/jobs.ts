import { MAX_COMMAND_BYTES, createMessage, jobStatusSchema } from '@relaydock/protocol';
import type { ServerToAgentMessage } from '@relaydock/protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import {
  environmentNameSchema,
  jsonStringArray,
  normalizeWorkingDirectory,
} from '../lib/domain.js';
import { AppError } from '../lib/errors.js';
import { serializeJob } from '../lib/serializers.js';
import type { DatabaseClient } from '../prisma.js';
import type { AuditService } from '../services/audit.js';
import type { ConnectionHub } from '../services/connections.js';
import type { JobService } from '../services/jobs.js';

const repositoryParametersSchema = z.object({ repositoryId: z.string().uuid() });
const jobParametersSchema = z.object({ jobId: z.string().uuid() });
const actionJobSchema = z
  .object({
    actionId: z.string().uuid(),
    confirmation: z.boolean().default(false),
  })
  .strict();
const customJobSchema = z
  .object({
    command: z.string().min(1).max(MAX_COMMAND_BYTES),
    workingDirectory: z.string().max(4096).default(''),
    interactive: z.boolean().default(false),
    persistent: z.boolean().default(false),
    confirmation: z.literal(true),
  })
  .strict();
const createJobSchema = z.union([actionJobSchema, customJobSchema]);
const listJobsSchema = z.object({
  deviceId: z.string().uuid().optional(),
  repositoryId: z.string().uuid().optional(),
  status: jobStatusSchema.optional(),
});
const outputQuerySchema = z.object({
  afterSequence: z.coerce.number().int().min(-1).default(-1),
});

export interface JobRouteDependencies {
  database: DatabaseClient;
  audit: AuditService;
  connections: ConnectionHub;
  jobs: JobService;
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  requireCsrf: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

function ownerId(request: FastifyRequest): string {
  if (request.auth === null) throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'Sign in.');
  return request.auth.user.id;
}

function safeWorkingDirectory(value: string): string {
  try {
    return normalizeWorkingDirectory(value);
  } catch (error) {
    throw new AppError(
      400,
      'WORKING_DIRECTORY_INVALID',
      error instanceof Error ? error.message : 'Invalid working directory.',
    );
  }
}

export function registerJobRoutes(app: FastifyInstance, dependencies: JobRouteDependencies): void {
  const { database, audit, connections, jobs, requireAuth, requireCsrf } = dependencies;

  app.post(
    '/api/repositories/:repositoryId/jobs',
    { preHandler: [requireAuth, requireCsrf] },
    async (request, reply) => {
      const { repositoryId } = repositoryParametersSchema.parse(request.params);
      const input = createJobSchema.parse(request.body);
      const userId = ownerId(request);
      const repository = await database.repository.findFirst({
        where: { id: repositoryId, device: { userId } },
        include: { device: true },
      });
      if (repository === null) {
        throw new AppError(404, 'REPOSITORY_NOT_FOUND', 'Repository not found.');
      }
      if (!repository.enabled) {
        throw new AppError(409, 'REPOSITORY_DISABLED', 'This repository is disabled.');
      }
      if (repository.device.status === 'revoked') {
        throw new AppError(409, 'DEVICE_REVOKED', 'The device has been revoked.');
      }
      if (!connections.isAgentOnline(repository.deviceId)) {
        throw new AppError(409, 'DEVICE_OFFLINE', 'The device must be online to start a job.');
      }

      let actionId: string | null = null;
      let command: string;
      let workingDirectory: string;
      let interactive: boolean;
      let persistent: boolean;
      if ('actionId' in input) {
        const action = await database.action.findFirst({
          where: { id: input.actionId, repositoryId },
        });
        if (action === null) throw new AppError(404, 'ACTION_NOT_FOUND', 'Action not found.');
        if (action.confirmationRequired && !input.confirmation) {
          throw new AppError(
            409,
            'CONFIRMATION_REQUIRED',
            'Confirm this action before running it.',
          );
        }
        actionId = action.id;
        command = action.command;
        workingDirectory = action.workingDirectory;
        interactive = action.interactive;
        persistent = action.persistent;
      } else {
        if (!repository.allowCustomCommands) {
          throw new AppError(403, 'CUSTOM_COMMANDS_DISABLED', 'Custom commands are disabled.');
        }
        command = input.command;
        workingDirectory = safeWorkingDirectory(input.workingDirectory);
        interactive = input.interactive;
        persistent = input.persistent;
      }
      if (Buffer.byteLength(command, 'utf8') > MAX_COMMAND_BYTES) {
        throw new AppError(400, 'COMMAND_TOO_LARGE', 'The command exceeds the protocol limit.');
      }

      let job = await database.job.create({
        data: {
          userId,
          deviceId: repository.deviceId,
          repositoryId,
          actionId,
          command,
          workingDirectory,
          interactive,
          persistent,
        },
        include: {
          repository: { select: { id: true, name: true } },
          device: { select: { id: true, name: true } },
        },
      });

      const startMessage: ServerToAgentMessage = createMessage('job.start', {
        jobId: job.id,
        repositoryId,
        repositoryPath: repository.absolutePath,
        command,
        workingDirectory,
        interactive,
        persistent,
        shell: repository.shell,
        shellArgs: jsonStringArray(repository.shellArgs),
        inheritedEnvironment: jsonStringArray(
          repository.inheritedEnvironment,
          z.array(environmentNameSchema).max(100),
        ),
        columns: 80,
        rows: 24,
      });
      if (!connections.sendToAgent(repository.deviceId, startMessage)) {
        job = await database.job.update({
          where: { id: job.id },
          data: {
            status: 'failed',
            statusDetail: 'Device disconnected before dispatch.',
            finishedAt: new Date(),
          },
          include: {
            repository: { select: { id: true, name: true } },
            device: { select: { id: true, name: true } },
          },
        });
      }
      await audit.record(request, {
        action: 'job.started',
        userId,
        deviceId: repository.deviceId,
        metadata: {
          jobId: job.id,
          repositoryId,
          ...(actionId === null ? {} : { actionId }),
        },
      });
      return reply.status(201).send({ job: serializeJob(job) });
    },
  );

  app.get('/api/jobs', { preHandler: requireAuth }, async (request) => {
    const query = listJobsSchema.parse(request.query);
    const jobRows = await database.job.findMany({
      where: {
        userId: ownerId(request),
        ...(query.deviceId === undefined ? {} : { deviceId: query.deviceId }),
        ...(query.repositoryId === undefined ? {} : { repositoryId: query.repositoryId }),
        ...(query.status === undefined ? {} : { status: query.status }),
      },
      include: {
        repository: { select: { id: true, name: true } },
        device: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return { jobs: jobRows.map(serializeJob) };
  });

  app.get('/api/jobs/:jobId', { preHandler: requireAuth }, async (request) => {
    const { jobId } = jobParametersSchema.parse(request.params);
    const job = await database.job.findFirst({
      where: { id: jobId, userId: ownerId(request) },
      include: {
        repository: { select: { id: true, name: true } },
        device: { select: { id: true, name: true } },
      },
    });
    if (job === null) throw new AppError(404, 'JOB_NOT_FOUND', 'Job not found.');
    return { job: serializeJob(job) };
  });

  app.get('/api/jobs/:jobId/output', { preHandler: requireAuth }, async (request) => {
    const { jobId } = jobParametersSchema.parse(request.params);
    const { afterSequence } = outputQuerySchema.parse(request.query);
    return { chunks: await jobs.replay(ownerId(request), jobId, afterSequence) };
  });

  app.post(
    '/api/jobs/:jobId/cancel',
    { preHandler: [requireAuth, requireCsrf] },
    async (request) => {
      const { jobId } = jobParametersSchema.parse(request.params);
      const userId = ownerId(request);
      const job = await jobs.requestCancellation(userId, jobId);
      await audit.record(request, {
        action: 'job.cancellation_requested',
        userId,
        deviceId: job.deviceId,
        metadata: { jobId },
      });
      return { job: serializeJob(job) };
    },
  );
}
