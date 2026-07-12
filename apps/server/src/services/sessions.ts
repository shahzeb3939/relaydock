import { relayDockNames } from '@relaydock/config';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { ServerEnvironment } from '../env.js';
import { constantTimeEqual, createOpaqueToken, hashOpaqueToken } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import type { DatabaseClient } from '../prisma.js';

const CSRF_COOKIE = 'relaydock_csrf';

export interface AuthContext {
  sessionId: string;
  csrfTokenHash: string;
  user: {
    id: string;
    email: string;
    createdAt: Date;
  };
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

export class SessionService {
  constructor(
    private readonly database: DatabaseClient,
    private readonly environment: ServerEnvironment,
  ) {}

  async create(userId: string, reply: FastifyReply): Promise<string> {
    const sessionToken = createOpaqueToken('rds');
    const csrfToken = createOpaqueToken('csrf');
    const expiresAt = new Date(Date.now() + this.environment.SESSION_TTL_HOURS * 60 * 60 * 1000);
    await this.database.session.create({
      data: {
        userId,
        tokenHash: hashOpaqueToken(sessionToken, this.environment.SESSION_SECRET),
        csrfTokenHash: hashOpaqueToken(csrfToken, this.environment.SESSION_SECRET),
        expiresAt,
      },
    });
    this.setCookies(reply, sessionToken, csrfToken);
    return csrfToken;
  }

  async authenticate(request: FastifyRequest): Promise<AuthContext> {
    const rawToken = request.cookies[relayDockNames.sessionCookie];
    if (rawToken === undefined || rawToken.length > 256) {
      throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'Sign in to continue.');
    }

    const session = await this.database.session.findUnique({
      where: { tokenHash: hashOpaqueToken(rawToken, this.environment.SESSION_SECRET) },
      include: { user: { select: { id: true, email: true, createdAt: true } } },
    });
    if (session === null || session.revokedAt !== null || session.expiresAt <= new Date()) {
      throw new AppError(401, 'SESSION_INVALID', 'The session has expired. Sign in again.');
    }

    request.auth = {
      sessionId: session.id,
      csrfTokenHash: session.csrfTokenHash,
      user: session.user,
    };
    void this.database.session
      .update({ where: { id: session.id }, data: { lastUsedAt: new Date() } })
      .catch((error: unknown) => request.log.warn({ err: error }, 'could not update session use'));
    return request.auth;
  }

  requireCsrf(request: FastifyRequest): void {
    if (request.auth === null) {
      throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'Sign in to continue.');
    }
    const header = request.headers[relayDockNames.csrfHeader];
    const headerToken = Array.isArray(header) ? header[0] : header;
    const cookieToken = request.cookies[CSRF_COOKIE];
    if (
      headerToken === undefined ||
      cookieToken === undefined ||
      !constantTimeEqual(headerToken, cookieToken) ||
      !constantTimeEqual(
        hashOpaqueToken(headerToken, this.environment.SESSION_SECRET),
        request.auth.csrfTokenHash,
      )
    ) {
      throw new AppError(403, 'CSRF_INVALID', 'The CSRF token is missing or invalid.');
    }
  }

  async revokeCurrent(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (request.auth !== null) {
      await this.database.session.updateMany({
        where: { id: request.auth.sessionId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    reply.clearCookie(relayDockNames.sessionCookie, this.cookieOptions(true));
    reply.clearCookie(CSRF_COOKIE, this.cookieOptions(false));
  }

  csrfFromRequest(request: FastifyRequest): string {
    const token = request.cookies[CSRF_COOKIE];
    if (token === undefined) {
      throw new AppError(401, 'SESSION_INVALID', 'The session is missing its CSRF token.');
    }
    return token;
  }

  private setCookies(reply: FastifyReply, sessionToken: string, csrfToken: string): void {
    const maxAge = this.environment.SESSION_TTL_HOURS * 60 * 60;
    reply.setCookie(relayDockNames.sessionCookie, sessionToken, {
      ...this.cookieOptions(true),
      maxAge,
    });
    reply.setCookie(CSRF_COOKIE, csrfToken, { ...this.cookieOptions(false), maxAge });
  }

  private cookieOptions(httpOnly: boolean) {
    return {
      path: '/',
      httpOnly,
      secure: this.environment.cookieSecure,
      sameSite: 'lax' as const,
    };
  }
}
