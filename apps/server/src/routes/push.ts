import { Prisma } from '@prisma/client';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { AppError } from '../lib/errors.js';
import type { DatabaseClient } from '../prisma.js';
import type { AuditService } from '../services/audit.js';
import { isAllowedPushEndpoint, type PushService } from '../services/push.js';

// A generous ceiling on browsers-per-user; the oldest is evicted past it so a
// new browser can always register while the table can't grow without bound.
const MAX_SUBSCRIPTIONS_PER_USER = 20;

// Shape produced by the browser's PushSubscription.toJSON(). The endpoint must
// belong to a real push provider (not an arbitrary host) — see isAllowedPushEndpoint.
const subscribeSchema = z.object({
  endpoint: z
    .string()
    .url()
    .max(2048)
    .refine(isAllowedPushEndpoint, 'endpoint is not a recognized push service host'),
  keys: z.object({
    p256dh: z.string().min(1).max(255),
    auth: z.string().min(1).max(255),
  }),
});
const unsubscribeSchema = z.object({ endpoint: z.string().url().max(2048) });

export interface PushRouteDependencies {
  database: DatabaseClient;
  push: PushService;
  audit: AuditService;
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  requireCsrf: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

function ownerId(request: FastifyRequest): string {
  if (request.auth === null) throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'Sign in.');
  return request.auth.user.id;
}

export function registerPushRoutes(app: FastifyInstance, dependencies: PushRouteDependencies): void {
  const { database, push, audit, requireAuth, requireCsrf } = dependencies;

  // Lets the web client discover whether push is configured and, if so, the
  // VAPID public key it must pass to PushManager.subscribe(). The public key is
  // not a secret; the private key never leaves the server.
  app.get('/api/push/config', { preHandler: requireAuth }, async () => ({
    enabled: push.enabled,
    publicKey: push.publicKey,
  }));

  app.post(
    '/api/push/subscribe',
    { preHandler: [requireAuth, requireCsrf] },
    async (request, reply) => {
      if (!push.enabled) {
        throw new AppError(404, 'PUSH_DISABLED', 'Push notifications are not configured.');
      }
      const userId = ownerId(request);
      const input = subscribeSchema.parse(request.body);
      const userAgentHeader = request.headers['user-agent'];
      const userAgent =
        typeof userAgentHeader === 'string' ? userAgentHeader.slice(0, 500) : null;

      // Refresh the caller's OWN row for this endpoint (idempotent re-subscribe
      // / key rotation). Scoped to userId so this can never touch another user's
      // row — an endpoint is globally unique, so reassigning it across accounts
      // would silently detach the previous owner's device.
      const refreshed = await database.pushSubscription.updateMany({
        where: { endpoint: input.endpoint, userId },
        data: { p256dh: input.keys.p256dh, auth: input.keys.auth, userAgent },
      });
      if (refreshed.count === 0) {
        const owned = await database.pushSubscription.count({ where: { userId } });
        if (owned >= MAX_SUBSCRIPTIONS_PER_USER) {
          const oldest = await database.pushSubscription.findFirst({
            where: { userId },
            orderBy: { createdAt: 'asc' },
            select: { id: true },
          });
          if (oldest !== null) {
            // deleteMany (not delete) so a concurrent prune/evict of the same
            // row returns count 0 instead of throwing P2025 and 500-ing this.
            await database.pushSubscription.deleteMany({ where: { id: oldest.id, userId } });
          }
        }
        try {
          await database.pushSubscription.create({
            data: {
              userId,
              endpoint: input.endpoint,
              p256dh: input.keys.p256dh,
              auth: input.keys.auth,
              userAgent,
            },
          });
        } catch (error) {
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            // The endpoint already exists. If the caller already owns it (a
            // same-user concurrent create race), refresh it and succeed;
            // otherwise it belongs to another account — refuse rather than
            // hijack it (the client re-subscribes with a fresh endpoint).
            const existing = await database.pushSubscription.findUnique({
              where: { endpoint: input.endpoint },
              select: { userId: true },
            });
            if (existing?.userId === userId) {
              await database.pushSubscription.updateMany({
                where: { endpoint: input.endpoint, userId },
                data: { p256dh: input.keys.p256dh, auth: input.keys.auth, userAgent },
              });
            } else {
              throw new AppError(
                409,
                'PUSH_ENDPOINT_CONFLICT',
                'This push endpoint is registered to another account.',
              );
            }
          } else {
            throw error;
          }
        }
      }
      await audit.record(request, { action: 'push.subscribe', userId });
      return reply.status(201).send({ ok: true });
    },
  );

  app.delete(
    '/api/push/subscribe',
    { preHandler: [requireAuth, requireCsrf] },
    async (request, reply) => {
      const userId = ownerId(request);
      const input = unsubscribeSchema.parse(request.body);
      // Scoped to the owner so one user cannot delete another's subscription.
      await database.pushSubscription.deleteMany({ where: { endpoint: input.endpoint, userId } });
      return reply.status(204).send();
    },
  );
}
