import type { DatabaseClient } from './prisma.js';
import { describe, expect, it, vi } from 'vitest';

import { buildServer } from './app.js';
import { parseServerEnvironment } from './env.js';

function testEnvironment() {
  return parseServerEnvironment({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://unused/relaydock',
    RELAYDOCK_SESSION_PEPPER: 'a-secure-test-secret-with-more-than-32-characters',
    RELAYDOCK_CREDENTIAL_PEPPER: 'a-distinct-device-secret-with-more-than-32-characters',
    RELAYDOCK_WEB_ORIGIN: 'http://localhost:5173',
    RELAYDOCK_ALLOW_REGISTRATION: 'true',
  });
}

function healthCheckDatabase(): DatabaseClient {
  // Routes are lazy, so this deliberately narrow test double only needs shutdown support.
  return { $disconnect: vi.fn(async () => undefined) } as unknown as DatabaseClient;
}

describe('server foundation', () => {
  it('serves liveness without a database dependency', async () => {
    const { app } = await buildServer({
      environment: testEnvironment(),
      database: healthCheckDatabase(),
      startMaintenance: false,
    });
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok' });
    await app.close();
  });

  it('rejects untrusted browser origins before route handling', async () => {
    const { app } = await buildServer({
      environment: testEnvironment(),
      database: healthCheckDatabase(),
      startMaintenance: false,
    });
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://attacker.example' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'ORIGIN_FORBIDDEN' } });
    await app.close();
  });
});
