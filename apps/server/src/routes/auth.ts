import { Prisma } from '@prisma/client';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { ServerEnvironment } from '../env.js';
import { hashPassword, verifyPassword } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import { serializeUser } from '../lib/serializers.js';
import type { DatabaseClient } from '../prisma.js';
import type { AuditService } from '../services/audit.js';
import type { SessionService } from '../services/sessions.js';

const credentialsSchema = z.object({
  email: z
    .string()
    .trim()
    .email()
    .max(320)
    .transform((email) => email.toLowerCase()),
  password: z.string().min(12).max(512),
});
const dummyPasswordHash = hashPassword('relaydock-login-timing-equalizer');

export interface AuthRouteDependencies {
  database: DatabaseClient;
  environment: ServerEnvironment;
  sessions: SessionService;
  audit: AuditService;
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  requireCsrf: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

export function registerAuthRoutes(
  app: FastifyInstance,
  dependencies: AuthRouteDependencies,
): void {
  const { database, environment, sessions, audit, requireAuth, requireCsrf } = dependencies;

  app.post(
    '/api/auth/register',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (!environment.ALLOW_REGISTRATION) {
        throw new AppError(403, 'REGISTRATION_DISABLED', 'Account registration is disabled.');
      }
      const input = credentialsSchema.parse(request.body);
      const passwordHash = await hashPassword(input.password);
      let user;
      try {
        user = await database.user.create({ data: { email: input.email, passwordHash } });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw new AppError(
            409,
            'EMAIL_ALREADY_REGISTERED',
            'An account already uses this email.',
          );
        }
        throw error;
      }
      const csrfToken = await sessions.create(user.id, reply);
      await audit.record(request, { action: 'auth.register', userId: user.id });
      return reply.status(201).send({ user: serializeUser(user), csrfToken });
    },
  );

  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const input = credentialsSchema.parse(request.body);
      const user = await database.user.findUnique({ where: { email: input.email } });
      const passwordHash = user?.passwordHash ?? (await dummyPasswordHash);
      const passwordMatches = await verifyPassword(passwordHash, input.password);
      if (user === null || !passwordMatches) {
        await audit.record(request, { action: 'auth.login_failed' });
        throw new AppError(401, 'INVALID_CREDENTIALS', 'The email or password is incorrect.');
      }
      const csrfToken = await sessions.create(user.id, reply);
      await audit.record(request, { action: 'auth.login', userId: user.id });
      return { user: serializeUser(user), csrfToken };
    },
  );

  app.get('/api/auth/session', { preHandler: requireAuth }, async (request) => {
    if (request.auth === null) throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'Sign in.');
    return {
      user: serializeUser(request.auth.user),
      csrfToken: sessions.csrfFromRequest(request),
    };
  });

  app.post(
    '/api/auth/logout',
    { preHandler: [requireAuth, requireCsrf] },
    async (request, reply) => {
      const userId = request.auth?.user.id;
      await sessions.revokeCurrent(request, reply);
      if (userId !== undefined) await audit.record(request, { action: 'auth.logout', userId });
      return reply.status(204).send();
    },
  );
}
