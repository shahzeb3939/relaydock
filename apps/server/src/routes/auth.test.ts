import { describe, expect, it, vi } from 'vitest';

import { buildServer } from '../app.js';
import type { ServerEnvironment } from '../env.js';
import { parseServerEnvironment } from '../env.js';
import type { DatabaseClient } from '../prisma.js';

function environment(overrides: Record<string, string> = {}): ServerEnvironment {
  return parseServerEnvironment({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://unused/relaydock',
    RELAYDOCK_SESSION_PEPPER: 'a-secure-test-secret-with-more-than-32-characters',
    RELAYDOCK_CREDENTIAL_PEPPER: 'a-distinct-device-secret-with-more-than-32-characters',
    RELAYDOCK_WEB_ORIGIN: 'http://localhost:5173',
    RELAYDOCK_ALLOW_REGISTRATION: 'true',
    ...overrides,
  });
}

function stubDatabase(): DatabaseClient {
  // Auth-config and the Google start/callback routes touch only audit logging,
  // so a narrow double covers everything these tests exercise.
  return {
    $disconnect: vi.fn(async () => undefined),
    auditEvent: { create: vi.fn(async () => undefined) },
  } as unknown as DatabaseClient;
}

const googleEnvironment = {
  GOOGLE_CLIENT_ID: 'client-123',
  GOOGLE_CLIENT_SECRET: 'secret-456',
  RELAYDOCK_PUBLIC_URL: 'https://relaydock.example',
  GOOGLE_ALLOWED_EMAIL_DOMAINS: 'emumba.com',
};

describe('auth configuration and Google sign-in wiring', () => {
  it('reports Google disabled by default', async () => {
    const { app } = await buildServer({
      environment: environment(),
      database: stubDatabase(),
      startMaintenance: false,
    });
    const response = await app.inject({ method: 'GET', url: '/api/auth/config' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ google: false, allowRegistration: true });
    await app.close();
  });

  it('does not register the Google start route when disabled', async () => {
    const { app } = await buildServer({
      environment: environment(),
      database: stubDatabase(),
      startMaintenance: false,
    });
    const response = await app.inject({ method: 'GET', url: '/api/auth/google' });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it('reports Google enabled and redirects into the flow when configured', async () => {
    const { app } = await buildServer({
      environment: environment(googleEnvironment),
      database: stubDatabase(),
      startMaintenance: false,
    });

    const config = await app.inject({ method: 'GET', url: '/api/auth/config' });
    expect(config.json()).toMatchObject({ google: true });

    const start = await app.inject({ method: 'GET', url: '/api/auth/google' });
    expect(start.statusCode).toBe(302);

    const location = new URL(start.headers.location as string);
    expect(`${location.origin}${location.pathname}`).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth',
    );
    expect(location.searchParams.get('redirect_uri')).toBe(
      'https://relaydock.example/api/auth/google/callback',
    );
    expect(location.searchParams.get('hd')).toBe('emumba.com');

    const state = location.searchParams.get('state');
    expect(state).toBeTruthy();
    const setCookie = start.headers['set-cookie'];
    const cookies = Array.isArray(setCookie) ? setCookie.join('; ') : String(setCookie);
    expect(cookies).toContain('relaydock_oauth_state=');
    expect(cookies).toContain(state as string);

    await app.close();
  });

  it('rejects a callback whose state does not match the cookie', async () => {
    const { app } = await buildServer({
      environment: environment(googleEnvironment),
      database: stubDatabase(),
      startMaintenance: false,
    });
    const response = await app.inject({
      method: 'GET',
      url: '/api/auth/google/callback?code=abc&state=forged',
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/login?error=google');
    await app.close();
  });
});
