import {
  MAX_PROTOCOL_MESSAGE_BYTES,
  agentToServerMessageSchema,
  clientToServerMessageSchema,
  createMessage,
} from '@relaydock/protocol';
import type {
  AgentToServerMessage,
  ServerToAgentMessage,
  ServerToClientMessage,
} from '@relaydock/protocol';
import type { WebSocket } from '@fastify/websocket';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { ServerEnvironment } from '../env.js';
import { hashOpaqueToken } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import type { DatabaseClient } from '../prisma.js';
import type { AuditService } from '../services/audit.js';
import type { ConnectionHub, RepositoryValidationBroker } from '../services/connections.js';
import type { JobService } from '../services/jobs.js';

type RawData = string | Buffer | ArrayBuffer | Buffer[];
const OPEN_STATE = 1;

interface AgentAuthContext {
  credentialId: string;
  deviceId: string;
  userId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    agentAuth: AgentAuthContext | null;
  }
}

export interface WebSocketRouteDependencies {
  database: DatabaseClient;
  environment: ServerEnvironment;
  audit: AuditService;
  connections: ConnectionHub;
  validations: RepositoryValidationBroker;
  jobs: JobService;
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

function rawDataBytes(data: RawData): number {
  if (typeof data === 'string') return Buffer.byteLength(data);
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (Array.isArray(data)) return data.reduce((sum, part) => sum + part.byteLength, 0);
  return data.byteLength;
}

function rawDataText(data: RawData): string {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return data.toString('utf8');
}

function closeForError(socket: WebSocket, request: FastifyRequest, error: unknown): void {
  request.log.warn({ err: error }, 'closing websocket after invalid message');
  if (socket.readyState === OPEN_STATE) {
    const reason = error instanceof AppError ? error.message : 'invalid protocol message';
    socket.close(1008, reason.slice(0, 123));
  }
}

function sendClient(socket: WebSocket, message: ServerToClientMessage): void {
  if (socket.readyState === OPEN_STATE) socket.send(JSON.stringify(message));
}

export function registerWebSocketRoutes(
  app: FastifyInstance,
  dependencies: WebSocketRouteDependencies,
): void {
  const { database, environment, audit, connections, validations, jobs, requireAuth } =
    dependencies;

  const authenticateAgent = async (request: FastifyRequest): Promise<void> => {
    const authorization = request.headers.authorization;
    const match = authorization?.match(/^Bearer ([A-Za-z0-9_-]{20,256})$/);
    if (match?.[1] === undefined) {
      throw new AppError(401, 'AGENT_CREDENTIAL_REQUIRED', 'A device credential is required.');
    }
    const credential = await database.deviceCredential.findUnique({
      where: {
        credentialHash: hashOpaqueToken(match[1], environment.CREDENTIAL_SECRET),
      },
      include: { device: { select: { id: true, userId: true, status: true } } },
    });
    if (
      credential === null ||
      credential.revokedAt !== null ||
      credential.device.status === 'revoked'
    ) {
      throw new AppError(401, 'AGENT_CREDENTIAL_INVALID', 'The device credential is invalid.');
    }
    await database.deviceCredential.update({
      where: { id: credential.id },
      data: { lastUsedAt: new Date() },
    });
    request.agentAuth = {
      credentialId: credential.id,
      deviceId: credential.device.id,
      userId: credential.device.userId,
    };
  };

  app.get('/ws/agent', { websocket: true, preValidation: authenticateAgent }, (socket, request) => {
    const authenticated = request.agentAuth;
    if (authenticated === null) {
      socket.close(1008, 'authentication required');
      return;
    }
    let helloReceived = false;
    let processing = Promise.resolve();
    const helloTimeout = setTimeout(() => {
      if (!helloReceived) socket.close(1008, 'agent.hello required');
    }, 10_000);
    helloTimeout.unref();

    const assertJobOwner = async (jobId: string): Promise<void> => {
      const job = await database.job.findFirst({
        where: { id: jobId, deviceId: authenticated.deviceId },
        select: { id: true },
      });
      if (job === null)
        throw new AppError(403, 'JOB_FORBIDDEN', 'Job does not belong to this device.');
    };

    // Ownership is a database read and job-to-device is immutable, so on the
    // high-frequency output path we verify a job once per connection and cache it.
    const ownedJobs = new Set<string>();
    const ensureJobOwner = async (jobId: string): Promise<void> => {
      if (ownedJobs.has(jobId)) return;
      await assertJobOwner(jobId);
      ownedJobs.add(jobId);
    };

    const updateConnectedDevice = async (
      data: Parameters<typeof database.device.updateMany>[0]['data'],
    ): Promise<void> => {
      const updated = await database.device.updateMany({
        where: { id: authenticated.deviceId, status: { not: 'revoked' } },
        data,
      });
      if (updated.count === 0) {
        socket.close(4003, 'device revoked');
        throw new AppError(401, 'AGENT_CREDENTIAL_INVALID', 'The device credential is invalid.');
      }
    };

    const processMessage = async (message: AgentToServerMessage): Promise<void> => {
      if (!helloReceived && message.type !== 'agent.hello') {
        throw new AppError(400, 'HELLO_REQUIRED', 'agent.hello must be the first message.');
      }
      switch (message.type) {
        case 'agent.hello': {
          if (helloReceived || message.payload.deviceId !== authenticated.deviceId) {
            throw new AppError(
              403,
              'HELLO_INVALID',
              'Agent identity does not match its credential.',
            );
          }
          await connections.attachAgent(authenticated.deviceId, authenticated.userId, socket);
          helloReceived = true;
          clearTimeout(helloTimeout);
          const now = new Date();
          // Do not sync the device name from the agent. The name is set once at
          // pairing (from the agent hostname) and is user-owned thereafter — a
          // rename must survive reconnects. The agent still reports its hostname
          // in the hello payload, but we intentionally ignore it here so it can
          // no longer clobber a name the user chose in the app.
          await updateConnectedDevice({
            platform: message.payload.platform,
            architecture: message.payload.architecture,
            agentVersion: message.payload.agentVersion,
            status: 'online',
            lastSeenAt: now,
          });
          const welcome: ServerToAgentMessage = createMessage('agent.welcome', {
            deviceId: authenticated.deviceId,
            heartbeatIntervalMs: environment.HEARTBEAT_INTERVAL_MS,
            serverTime: now.toISOString(),
          });
          if (!(await connections.sendToAgent(authenticated.deviceId, welcome))) {
            throw new AppError(409, 'DEVICE_DISCONNECTED', 'The agent connection was lost.');
          }
          const deviceStatus: ServerToClientMessage = createMessage('device.status', {
            deviceId: authenticated.deviceId,
            status: 'online',
            lastSeenAt: now.toISOString(),
          });
          await connections.broadcastDevice(authenticated.userId, deviceStatus);

          const runningJobs = await database.job.findMany({
            where: {
              id: { in: message.payload.runningJobIds },
              deviceId: authenticated.deviceId,
              status: {
                in: ['queued', 'dispatched', 'running', 'waiting_for_input', 'disconnected'],
              },
            },
          });
          for (const job of runningJobs) {
            if (job.status === 'queued') {
              await jobs.transitionFromAgent(authenticated.deviceId, job.id, 'dispatched');
            }
            const reconciledStatus =
              job.status === 'waiting_for_input' ? 'waiting_for_input' : 'running';
            await jobs.transitionFromAgent(authenticated.deviceId, job.id, reconciledStatus);
            const bufferRequest: ServerToAgentMessage = createMessage('job.buffer.request', {
              jobId: job.id,
              afterSequence: await jobs.latestSequence(job.id),
            });
            await connections.sendToAgent(authenticated.deviceId, bufferRequest);
          }
          request.log.info({ deviceId: authenticated.deviceId }, 'agent connected');
          return;
        }
        case 'agent.heartbeat': {
          if (message.payload.deviceId !== authenticated.deviceId) {
            throw new AppError(403, 'DEVICE_FORBIDDEN', 'Heartbeat identity mismatch.');
          }
          if (!(await connections.heartbeat(authenticated.deviceId, socket))) return;
          await updateConnectedDevice({ status: 'online', lastSeenAt: new Date() });
          return;
        }
        case 'agent.status': {
          if (message.payload.deviceId !== authenticated.deviceId) {
            throw new AppError(403, 'DEVICE_FORBIDDEN', 'Status identity mismatch.');
          }
          const now = new Date();
          await updateConnectedDevice({ status: message.payload.status, lastSeenAt: now });
          const statusMessage: ServerToClientMessage = createMessage('device.status', {
            deviceId: authenticated.deviceId,
            status: message.payload.status,
            lastSeenAt: now.toISOString(),
          });
          await connections.broadcastDevice(authenticated.userId, statusMessage);
          if (message.payload.status === 'offline') socket.close(1000, 'agent went offline');
          return;
        }
        case 'repository.validation.result':
          if (!(await validations.settle(authenticated.deviceId, message.payload))) {
            request.log.debug(
              { deviceId: authenticated.deviceId, repositoryId: message.payload.repositoryId },
              'ignored unsolicited repository validation',
            );
          }
          return;
        case 'job.accepted':
          await assertJobOwner(message.payload.jobId);
          await jobs.transitionFromAgent(
            authenticated.deviceId,
            message.payload.jobId,
            'dispatched',
          );
          return;
        case 'job.started':
          await assertJobOwner(message.payload.jobId);
          await jobs.transitionFromAgent(authenticated.deviceId, message.payload.jobId, 'running');
          return;
        case 'job.output':
          await ensureJobOwner(message.payload.jobId);
          // Relay to viewers immediately; the chunk persists in the background so
          // the live terminal is never gated on a cloud-database write.
          jobs.relayOutput(
            authenticated.userId,
            authenticated.deviceId,
            message.payload.jobId,
            message.payload,
          );
          return;
        case 'job.status':
          await assertJobOwner(message.payload.jobId);
          await jobs.transitionFromAgent(
            authenticated.deviceId,
            message.payload.jobId,
            message.payload.status,
            message.payload.detail === undefined ? {} : { detail: message.payload.detail },
          );
          return;
        case 'job.completed': {
          await assertJobOwner(message.payload.jobId);
          await jobs.flushOutput(message.payload.jobId);
          const job = await jobs.transitionFromAgent(
            authenticated.deviceId,
            message.payload.jobId,
            'completed',
            { exitCode: message.payload.exitCode },
          );
          if (job?.status === 'completed') {
            const completed: ServerToClientMessage = createMessage('job.completed', {
              jobId: job.id,
              exitCode: message.payload.exitCode,
            });
            await connections.broadcastJob(job.userId, job.id, completed);
          }
          return;
        }
        case 'job.failed': {
          await assertJobOwner(message.payload.jobId);
          await jobs.flushOutput(message.payload.jobId);
          const job = await jobs.transitionFromAgent(
            authenticated.deviceId,
            message.payload.jobId,
            'failed',
            {
              detail: message.payload.error,
              ...(message.payload.exitCode === undefined
                ? {}
                : { exitCode: message.payload.exitCode }),
            },
          );
          if (job?.status === 'failed') {
            const failed: ServerToClientMessage = createMessage('job.failed', {
              jobId: job.id,
              error: message.payload.error,
              exitCode: message.payload.exitCode ?? null,
            });
            await connections.broadcastJob(job.userId, job.id, failed);
          }
          return;
        }
        case 'job.cancelled':
          await assertJobOwner(message.payload.jobId);
          await jobs.flushOutput(message.payload.jobId);
          await jobs.transitionFromAgent(
            authenticated.deviceId,
            message.payload.jobId,
            'cancelled',
          );
          return;
        case 'job.input.acknowledged':
          await assertJobOwner(message.payload.jobId);
          return;
        case 'job.buffer.sync':
          await assertJobOwner(message.payload.jobId);
          await jobs.persistOutput(
            authenticated.deviceId,
            message.payload.jobId,
            message.payload.chunks,
          );
          return;
      }
      message satisfies never;
    };

    socket.on('message', (data: RawData) => {
      if (rawDataBytes(data) > MAX_PROTOCOL_MESSAGE_BYTES) {
        socket.close(1009, 'message too large');
        return;
      }
      processing = processing
        .then(async () => {
          let parsedJson: unknown;
          try {
            parsedJson = JSON.parse(rawDataText(data)) as unknown;
          } catch {
            throw new AppError(400, 'JSON_INVALID', 'Message is not valid JSON.');
          }
          const message = agentToServerMessageSchema.parse(parsedJson);
          await processMessage(message);
        })
        .catch((error: unknown) => closeForError(socket, request, error));
    });

    socket.on('close', () => {
      clearTimeout(helloTimeout);
      if (!helloReceived) return;
      const disconnectedAt = new Date();
      void (async () => {
        if (!(await connections.detachAgent(authenticated.deviceId, socket))) return;
        await validations.cancelForDevice(authenticated.deviceId);
        const now = disconnectedAt;
        const device = await database.device.findUnique({ where: { id: authenticated.deviceId } });
        if (device !== null && device.status !== 'revoked') {
          const updated = await database.device.updateMany({
            where: {
              id: authenticated.deviceId,
              updatedAt: { lte: disconnectedAt },
              status: { not: 'revoked' },
            },
            data: { status: 'offline', lastSeenAt: now },
          });
          if (updated.count === 1 && !(await connections.isAgentOnline(authenticated.deviceId))) {
            const status: ServerToClientMessage = createMessage('device.status', {
              deviceId: authenticated.deviceId,
              status: 'offline',
              lastSeenAt: now.toISOString(),
            });
            await connections.broadcastDevice(authenticated.userId, status);
          }
        }
        const affectedJobs = await database.job.findMany({
          where: {
            deviceId: authenticated.deviceId,
            status: { in: ['queued', 'dispatched', 'running', 'waiting_for_input'] },
            updatedAt: { lte: disconnectedAt },
          },
        });
        await database.$transaction([
          database.job.updateMany({
            where: {
              deviceId: authenticated.deviceId,
              status: 'queued',
              updatedAt: { lte: disconnectedAt },
            },
            data: {
              status: 'disconnected',
              statusDetail: 'Agent disconnected before acknowledgement; execution is unknown.',
            },
          }),
          database.job.updateMany({
            where: {
              deviceId: authenticated.deviceId,
              status: { in: ['dispatched', 'running', 'waiting_for_input'] },
              updatedAt: { lte: disconnectedAt },
            },
            data: { status: 'disconnected', statusDetail: 'Agent connection was lost.' },
          }),
        ]);
        for (const job of affectedJobs) {
          const status: ServerToClientMessage = createMessage('job.status', {
            jobId: job.id,
            status: 'disconnected',
            exitCode: job.exitCode,
          });
          await connections.broadcastJob(job.userId, job.id, status);
        }
        request.log.info({ deviceId: authenticated.deviceId }, 'agent disconnected');
      })().catch((error: unknown) =>
        request.log.error({ err: error }, 'disconnect cleanup failed'),
      );
    });

    socket.on('error', (error: Error) => request.log.warn({ err: error }, 'agent websocket error'));
  });

  app.get('/ws/client', { websocket: true, preValidation: requireAuth }, (socket, request) => {
    const userId = request.auth?.user.id;
    if (userId === undefined) {
      socket.close(1008, 'authentication required');
      return;
    }
    connections.attachClient(userId, socket);
    let processing = Promise.resolve();

    socket.on('message', (data: RawData) => {
      if (rawDataBytes(data) > MAX_PROTOCOL_MESSAGE_BYTES) {
        socket.close(1009, 'message too large');
        return;
      }
      processing = processing
        .then(async () => {
          let parsedJson: unknown;
          try {
            parsedJson = JSON.parse(rawDataText(data)) as unknown;
          } catch {
            throw new AppError(400, 'JSON_INVALID', 'Message is not valid JSON.');
          }
          const message = clientToServerMessageSchema.parse(parsedJson);
          switch (message.type) {
            case 'job.subscribe': {
              const job = await database.job.findFirst({
                where: { id: message.payload.jobId, userId },
              });
              if (job === null) throw new AppError(404, 'JOB_NOT_FOUND', 'Job not found.');
              connections.beginSubscription(socket, job.id);
              const chunks = await jobs.replay(userId, job.id, message.payload.afterSequence);
              for (const chunk of chunks) {
                const output: ServerToClientMessage = createMessage('job.output', {
                  jobId: job.id,
                  sequence: chunk.sequence,
                  stream: chunk.stream,
                  data: chunk.data,
                });
                sendClient(socket, output);
              }
              const status: ServerToClientMessage = createMessage('job.status', {
                jobId: job.id,
                status: job.status,
                exitCode: job.exitCode,
              });
              sendClient(socket, status);
              connections.finishSubscription(socket, job.id);
              return;
            }
            case 'job.unsubscribe':
              connections.unsubscribe(socket, message.payload.jobId);
              return;
            case 'job.input':
              await jobs.forwardInput(
                userId,
                message.payload.jobId,
                message.payload.inputSequence,
                message.payload.data,
              );
              return;
            case 'job.resize':
              await jobs.forwardResize(
                userId,
                message.payload.jobId,
                message.payload.columns,
                message.payload.rows,
              );
              return;
            case 'job.cancel': {
              const job = await jobs.requestCancellation(userId, message.payload.jobId);
              await audit.record(request, {
                action: 'job.cancellation_requested',
                userId,
                deviceId: job.deviceId,
                metadata: { jobId: job.id, source: 'websocket' },
              });
              return;
            }
          }
          message satisfies never;
        })
        .catch((error: unknown) => closeForError(socket, request, error));
    });

    socket.on('close', () => connections.detachClient(socket));
    socket.on('error', (error: Error) =>
      request.log.debug({ err: error }, 'client websocket error'),
    );
  });
}
