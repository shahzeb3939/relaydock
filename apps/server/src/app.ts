import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { relayDockNames } from '@relaydock/config';
import { MAX_PROTOCOL_MESSAGE_BYTES } from '@relaydock/protocol';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { ServerEnvironment } from './env.js';
import { parseServerEnvironment } from './env.js';
import { AppError, installErrorHandler } from './lib/errors.js';
import { createPrismaClient } from './prisma.js';
import type { DatabaseClient } from './prisma.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerDeviceRoutes } from './routes/devices.js';
import { registerJobRoutes } from './routes/jobs.js';
import { registerPushRoutes } from './routes/push.js';
import { registerRepositoryRoutes } from './routes/repositories.js';
import { registerWebSocketRoutes } from './routes/websockets.js';
import { AuditService } from './services/audit.js';
import { ConnectionHub, RepositoryValidationBroker } from './services/connections.js';
import { JobService } from './services/jobs.js';
import { MaintenanceService } from './services/maintenance.js';
import { PushService } from './services/push.js';
import { SessionService } from './services/sessions.js';

export interface BuildServerOptions {
  environment?: ServerEnvironment;
  database?: DatabaseClient;
  startMaintenance?: boolean;
}

export interface RelayDockServer {
  app: FastifyInstance;
  environment: ServerEnvironment;
  database: DatabaseClient;
}

export async function buildServer(options: BuildServerOptions = {}): Promise<RelayDockServer> {
  const environment = options.environment ?? parseServerEnvironment(process.env);
  const database = options.database ?? createPrismaClient();
  const allowedOrigins = new Set(environment.ALLOWED_ORIGINS);
  const app = Fastify({
    bodyLimit: MAX_PROTOCOL_MESSAGE_BYTES,
    trustProxy: environment.TRUST_PROXY,
    logger:
      environment.NODE_ENV === 'test'
        ? false
        : {
            level: environment.LOG_LEVEL,
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers.cookie',
                'request.headers.authorization',
                'request.headers.cookie',
                'body.password',
                'body.credential',
              ],
              censor: '[REDACTED]',
            },
          },
  });

  app.decorateRequest('auth', null);
  app.decorateRequest('agentAuth', null);
  await app.register(cookie);
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    credentials: true,
    allowedHeaders: ['content-type', relayDockNames.csrfHeader],
    origin(origin, callback) {
      callback(null, origin === undefined || allowedOrigins.has(origin));
    },
  });
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
  });
  await app.register(websocket, {
    options: { maxPayload: MAX_PROTOCOL_MESSAGE_BYTES },
  });

  app.addHook('onRequest', async (request) => {
    // The Google OAuth callback is a top-level cross-site GET navigation from
    // the identity provider: it legitimately carries no trusted Origin and
    // Sec-Fetch-Site: cross-site. Its CSRF defence is the unguessable state
    // parameter validated in the callback handler, so it is exempt from the
    // browser-origin guard below.
    if (request.url.split('?', 1)[0] === '/api/auth/google/callback') return;
    const origin = request.headers.origin;
    if (origin !== undefined && !allowedOrigins.has(origin)) {
      throw new AppError(403, 'ORIGIN_FORBIDDEN', 'This browser origin is not allowed.');
    }
    if (origin === undefined && request.headers['sec-fetch-site'] === 'cross-site') {
      throw new AppError(403, 'ORIGIN_FORBIDDEN', 'Cross-site browser requests are not allowed.');
    }
  });

  installErrorHandler(app);

  const sessions = new SessionService(database, environment);
  const audit = new AuditService(database);
  const connections = new ConnectionHub({
    redisUrl: environment.REDIS_URL,
    namespace: environment.REDIS_NAMESPACE,
    presenceTtlMs: environment.OFFLINE_AFTER_MS,
    requestTimeoutMs: environment.RELAY_ACK_TIMEOUT_MS,
  });
  await connections.start();
  const validations = new RepositoryValidationBroker(connections, environment);
  const push = new PushService({
    database,
    logger: app.log,
    vapid: environment.pushEnabled
      ? {
          publicKey: environment.VAPID_PUBLIC_KEY as string,
          privateKey: environment.VAPID_PRIVATE_KEY as string,
          subject: environment.VAPID_SUBJECT as string,
        }
      : null,
  });
  const jobs = new JobService(
    database,
    connections,
    environment.MAX_RETAINED_OUTPUT_BYTES,
    push,
    app.log,
  );
  const maintenance = new MaintenanceService(database, connections, environment, app.log);

  const requireAuth = async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    await sessions.authenticate(request);
  };
  const requireCsrf = async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    sessions.requireCsrf(request);
  };

  app.get('/health', { config: { rateLimit: false } }, async () => ({
    status: 'ok',
    uptimeSeconds: Math.floor(process.uptime()),
  }));
  app.get('/ready', { config: { rateLimit: false } }, async (_request, reply) => {
    try {
      await database.$queryRaw`SELECT 1`;
      return { status: 'ready' };
    } catch {
      return reply.status(503).send({ status: 'not_ready' });
    }
  });
  app.get('/api/internal/maintenance', { config: { rateLimit: false } }, async (request) => {
    if (environment.CRON_SECRET === undefined) {
      throw new AppError(404, 'NOT_FOUND', 'Not found.');
    }
    if (request.headers.authorization !== `Bearer ${environment.CRON_SECRET}`) {
      throw new AppError(
        401,
        'MAINTENANCE_AUTHENTICATION_REQUIRED',
        'A valid maintenance credential is required.',
      );
    }
    await maintenance.cleanup();
    return { status: 'ok' };
  });

  registerAuthRoutes(app, {
    database,
    environment,
    sessions,
    audit,
    requireAuth,
    requireCsrf,
  });
  registerDeviceRoutes(app, {
    database,
    environment,
    audit,
    connections,
    validations,
    requireAuth,
    requireCsrf,
  });
  registerRepositoryRoutes(app, {
    database,
    audit,
    connections,
    validations,
    requireAuth,
    requireCsrf,
  });
  registerJobRoutes(app, { database, audit, connections, jobs, requireAuth, requireCsrf });
  registerPushRoutes(app, { database, push, audit, requireAuth, requireCsrf });
  registerWebSocketRoutes(app, {
    database,
    environment,
    audit,
    connections,
    validations,
    jobs,
    requireAuth,
  });

  if (options.startMaintenance !== false) await maintenance.start();

  app.addHook('onClose', async () => {
    maintenance.stop();
    await validations.shutdown();
    await connections.shutdown();
    await database.$disconnect();
  });

  return { app, environment, database };
}
