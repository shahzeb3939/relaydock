import path from 'node:path';

import { Prisma } from '@prisma/client';
import { MAX_COMMAND_BYTES } from '@relaydock/protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { environmentNameSchema, normalizeWorkingDirectory } from '../lib/domain.js';
import { AppError } from '../lib/errors.js';
import { serializeAction, serializeRepository } from '../lib/serializers.js';
import type { DatabaseClient } from '../prisma.js';
import type { AuditService } from '../services/audit.js';
import type { ConnectionHub, RepositoryValidationBroker } from '../services/connections.js';

const repositoryParametersSchema = z.object({ repositoryId: z.string().uuid() });
const actionParametersSchema = z.object({ actionId: z.string().uuid() });
const updateRepositorySchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    absolutePath: z.string().trim().min(1).max(4096).optional(),
    description: z.string().trim().max(1000).optional(),
    allowCustomCommands: z.boolean().optional(),
    shell: z.string().trim().min(1).max(4096).optional(),
    shellArgs: z.array(z.string().max(1000)).max(20).optional(),
    inheritedEnvironment: z.array(environmentNameSchema).max(100).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((input) => Object.keys(input).length > 0, 'At least one field is required.');
const actionSchema = z.object({
  name: z.string().trim().min(1).max(100),
  command: z.string().min(1).max(MAX_COMMAND_BYTES),
  workingDirectory: z.string().max(4096).default(''),
  interactive: z.boolean().default(false),
  persistent: z.boolean().default(false),
  confirmationRequired: z.boolean().default(false),
});
const updateActionSchema = actionSchema
  .partial()
  .refine((input) => Object.keys(input).length > 0, 'At least one field is required.');

export interface RepositoryRouteDependencies {
  database: DatabaseClient;
  audit: AuditService;
  connections: ConnectionHub;
  validations: RepositoryValidationBroker;
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  requireCsrf: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

function ownerId(request: FastifyRequest): string {
  if (request.auth === null) throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'Sign in.');
  return request.auth.user.id;
}

function validateCommand(command: string): void {
  if (Buffer.byteLength(command, 'utf8') > MAX_COMMAND_BYTES) {
    throw new AppError(400, 'COMMAND_TOO_LARGE', 'The command exceeds the protocol limit.');
  }
}

function workingDirectory(value: string | undefined): string {
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

function pathLooksAbsolute(value: string): boolean {
  return path.posix.isAbsolute(value) || path.win32.isAbsolute(value);
}

export function registerRepositoryRoutes(
  app: FastifyInstance,
  dependencies: RepositoryRouteDependencies,
): void {
  const { database, audit, connections, validations, requireAuth, requireCsrf } = dependencies;

  app.get('/api/repositories/:repositoryId', { preHandler: requireAuth }, async (request) => {
    const { repositoryId } = repositoryParametersSchema.parse(request.params);
    const repository = await database.repository.findFirst({
      where: { id: repositoryId, device: { userId: ownerId(request) } },
      include: { device: { select: { id: true, name: true, status: true } } },
    });
    if (repository === null) {
      throw new AppError(404, 'REPOSITORY_NOT_FOUND', 'Repository not found.');
    }
    return { repository: serializeRepository(repository) };
  });

  app.patch(
    '/api/repositories/:repositoryId',
    { preHandler: [requireAuth, requireCsrf] },
    async (request) => {
      const { repositoryId } = repositoryParametersSchema.parse(request.params);
      const input = updateRepositorySchema.parse(request.body);
      const userId = ownerId(request);
      let repository = await database.repository.findFirst({
        where: { id: repositoryId, device: { userId } },
      });
      if (repository === null) {
        throw new AppError(404, 'REPOSITORY_NOT_FOUND', 'Repository not found.');
      }

      const nextPath = input.absolutePath;
      const pathChanged = nextPath !== undefined && nextPath !== repository.absolutePath;
      if (pathChanged) {
        if (!pathLooksAbsolute(nextPath)) {
          throw new AppError(400, 'PATH_NOT_ABSOLUTE', 'Repository path must be absolute.');
        }
        if (!(await connections.isAgentOnline(repository.deviceId))) {
          throw new AppError(409, 'DEVICE_OFFLINE', 'The device must be online to change a path.');
        }
        const wasEnabled = repository.enabled;
        await database.repository.update({ where: { id: repositoryId }, data: { enabled: false } });
        try {
          const validation = await validations.request(repository.deviceId, repositoryId, nextPath);
          if (!validation.valid || validation.canonicalPath === undefined) {
            throw new AppError(
              422,
              'REPOSITORY_INVALID',
              validation.error ?? 'The agent could not validate this path.',
            );
          }
          repository = await database.repository.update({
            where: { id: repositoryId },
            data: {
              absolutePath: validation.canonicalPath,
              repositoryRoot: validation.repositoryRoot ?? validation.canonicalPath,
              isGitRepository: validation.isGitRepository,
              branch: validation.branch ?? null,
              enabled: input.enabled ?? wasEnabled,
            },
          });
        } catch (error) {
          await database.repository.update({
            where: { id: repositoryId },
            data: { enabled: wasEnabled },
          });
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            throw new AppError(409, 'REPOSITORY_EXISTS', 'That path is already registered.');
          }
          throw error;
        }
      }

      repository = await database.repository.update({
        where: { id: repositoryId },
        data: {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.description === undefined
            ? {}
            : { description: input.description === '' ? null : input.description }),
          ...(input.allowCustomCommands === undefined
            ? {}
            : { allowCustomCommands: input.allowCustomCommands }),
          ...(input.shell === undefined ? {} : { shell: input.shell }),
          ...(input.shellArgs === undefined ? {} : { shellArgs: input.shellArgs }),
          ...(input.inheritedEnvironment === undefined
            ? {}
            : { inheritedEnvironment: input.inheritedEnvironment }),
          ...(input.enabled === undefined || pathChanged ? {} : { enabled: input.enabled }),
        },
      });
      await audit.record(request, {
        action: 'repository.updated',
        userId,
        deviceId: repository.deviceId,
        metadata: { repositoryId },
      });
      return { repository: serializeRepository(repository) };
    },
  );

  app.delete(
    '/api/repositories/:repositoryId',
    { preHandler: [requireAuth, requireCsrf] },
    async (request, reply) => {
      const { repositoryId } = repositoryParametersSchema.parse(request.params);
      const userId = ownerId(request);
      const repository = await database.repository.findFirst({
        where: { id: repositoryId, device: { userId } },
        include: { _count: { select: { jobs: true } } },
      });
      if (repository === null) {
        throw new AppError(404, 'REPOSITORY_NOT_FOUND', 'Repository not found.');
      }
      if (repository._count.jobs > 0) {
        throw new AppError(
          409,
          'REPOSITORY_HAS_HISTORY',
          'Disable this repository instead; job history still references it.',
        );
      }
      await database.repository.delete({ where: { id: repositoryId } });
      await audit.record(request, {
        action: 'repository.deleted',
        userId,
        deviceId: repository.deviceId,
        metadata: { repositoryId },
      });
      return reply.status(204).send();
    },
  );

  app.get(
    '/api/repositories/:repositoryId/actions',
    { preHandler: requireAuth },
    async (request) => {
      const { repositoryId } = repositoryParametersSchema.parse(request.params);
      const repository = await database.repository.findFirst({
        where: { id: repositoryId, device: { userId: ownerId(request) } },
        select: { id: true },
      });
      if (repository === null) {
        throw new AppError(404, 'REPOSITORY_NOT_FOUND', 'Repository not found.');
      }
      const actions = await database.action.findMany({
        where: { repositoryId },
        orderBy: { name: 'asc' },
      });
      return { actions: actions.map(serializeAction) };
    },
  );

  app.post(
    '/api/repositories/:repositoryId/actions',
    { preHandler: [requireAuth, requireCsrf] },
    async (request, reply) => {
      const { repositoryId } = repositoryParametersSchema.parse(request.params);
      const input = actionSchema.parse(request.body);
      validateCommand(input.command);
      const userId = ownerId(request);
      const repository = await database.repository.findFirst({
        where: { id: repositoryId, device: { userId } },
      });
      if (repository === null) {
        throw new AppError(404, 'REPOSITORY_NOT_FOUND', 'Repository not found.');
      }
      const action = await database.action.create({
        data: {
          repositoryId,
          name: input.name,
          command: input.command,
          workingDirectory: workingDirectory(input.workingDirectory),
          interactive: input.interactive,
          persistent: input.persistent,
          confirmationRequired: input.confirmationRequired,
        },
      });
      await audit.record(request, {
        action: 'action.created',
        userId,
        deviceId: repository.deviceId,
        metadata: { repositoryId, actionId: action.id },
      });
      return reply.status(201).send({ action: serializeAction(action) });
    },
  );

  app.patch(
    '/api/actions/:actionId',
    { preHandler: [requireAuth, requireCsrf] },
    async (request) => {
      const { actionId } = actionParametersSchema.parse(request.params);
      const input = updateActionSchema.parse(request.body);
      if (input.command !== undefined) validateCommand(input.command);
      const action = await database.action.findFirst({
        where: { id: actionId, repository: { device: { userId: ownerId(request) } } },
      });
      if (action === null) throw new AppError(404, 'ACTION_NOT_FOUND', 'Action not found.');
      const updated = await database.action.update({
        where: { id: actionId },
        data: {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.command === undefined ? {} : { command: input.command }),
          ...(input.workingDirectory === undefined
            ? {}
            : { workingDirectory: workingDirectory(input.workingDirectory) }),
          ...(input.interactive === undefined ? {} : { interactive: input.interactive }),
          ...(input.persistent === undefined ? {} : { persistent: input.persistent }),
          ...(input.confirmationRequired === undefined
            ? {}
            : { confirmationRequired: input.confirmationRequired }),
        },
      });
      return { action: serializeAction(updated) };
    },
  );

  app.delete(
    '/api/actions/:actionId',
    { preHandler: [requireAuth, requireCsrf] },
    async (request, reply) => {
      const { actionId } = actionParametersSchema.parse(request.params);
      const action = await database.action.findFirst({
        where: { id: actionId, repository: { device: { userId: ownerId(request) } } },
      });
      if (action === null) throw new AppError(404, 'ACTION_NOT_FOUND', 'Action not found.');
      await database.action.delete({ where: { id: actionId } });
      return reply.status(204).send();
    },
  );
}
