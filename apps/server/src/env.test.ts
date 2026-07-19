import { describe, expect, it } from 'vitest';

import { parseServerEnvironment } from './env.js';

const baseEnvironment = {
  DATABASE_URL: 'postgresql://relaydock:relaydock@localhost:5432/relaydock',
  RELAYDOCK_SESSION_PEPPER: 'a-secure-test-secret-with-more-than-32-characters',
  RELAYDOCK_CREDENTIAL_PEPPER: 'a-distinct-device-secret-with-more-than-32-characters',
};

describe('server environment', () => {
  it('parses booleans without treating the string false as true', () => {
    const environment = parseServerEnvironment({
      ...baseEnvironment,
      RELAYDOCK_ALLOW_REGISTRATION: 'false',
      RELAYDOCK_TRUST_PROXY: 'true',
    });
    expect(environment.ALLOW_REGISTRATION).toBe(false);
    expect(environment.TRUST_PROXY).toBe(true);
    expect(environment.cookieSecure).toBe(false);
  });

  it('requires enough entropy in the token hashing secret', () => {
    expect(() =>
      parseServerEnvironment({ ...baseEnvironment, RELAYDOCK_SESSION_PEPPER: 'too-short' }),
    ).toThrow();
  });

  it('rejects a heartbeat timeout shorter than the heartbeat interval', () => {
    expect(() =>
      parseServerEnvironment({
        ...baseEnvironment,
        RELAYDOCK_HEARTBEAT_INTERVAL_MS: '15000',
        RELAYDOCK_OFFLINE_AFTER_MS: '15000',
      }),
    ).toThrow(/OFFLINE_AFTER_MS/);
  });

  it('prefers RelayDock-prefixed values over legacy aliases', () => {
    const environment = parseServerEnvironment({
      ...baseEnvironment,
      PORT: '9999',
      RELAYDOCK_PORT: '3100',
      ALLOWED_ORIGINS: 'https://legacy.example',
      RELAYDOCK_WEB_ORIGIN: 'https://relay.example',
    });
    expect(environment.PORT).toBe(3100);
    expect(environment.ALLOWED_ORIGINS).toEqual(['https://relay.example']);
  });

  it('requires independent session and device peppers in production', () => {
    const sharedPepper = 'this-value-is-long-enough-but-intentionally-reused';
    expect(() =>
      parseServerEnvironment({
        ...baseEnvironment,
        NODE_ENV: 'production',
        RELAYDOCK_SESSION_PEPPER: sharedPepper,
        RELAYDOCK_CREDENTIAL_PEPPER: sharedPepper,
      }),
    ).toThrow(/CREDENTIAL_SECRET/);
  });

  it('accepts a namespaced Redis relay configuration', () => {
    const environment = parseServerEnvironment({
      ...baseEnvironment,
      KV_URL: 'rediss://default:secret@example.test:6379',
      RELAYDOCK_REDIS_NAMESPACE: 'production',
      RELAYDOCK_RELAY_ACK_TIMEOUT_MS: '2500',
      CRON_SECRET: 'a-cron-secret-with-more-than-32-characters',
    });

    expect(environment.REDIS_URL).toBe('rediss://default:secret@example.test:6379');
    expect(environment.REDIS_NAMESPACE).toBe('production');
    expect(environment.RELAY_ACK_TIMEOUT_MS).toBe(2500);
  });

  it('rejects non-Redis relay URLs', () => {
    expect(() =>
      parseServerEnvironment({
        ...baseEnvironment,
        RELAYDOCK_REDIS_URL: 'https://example.test/redis',
      }),
    ).toThrow(/redis:\/\//);
  });

  it('enables push when all three VAPID values are set', () => {
    const environment = parseServerEnvironment({
      ...baseEnvironment,
      VAPID_PUBLIC_KEY: 'a-public-key',
      VAPID_PRIVATE_KEY: 'a-private-key',
      VAPID_SUBJECT: 'mailto:ops@example.test',
    });
    expect(environment.pushEnabled).toBe(true);
    expect(environment.VAPID_PUBLIC_KEY).toBe('a-public-key');
  });

  it('treats blank VAPID values as unset so an empty passthrough keeps push inert', () => {
    // docker-compose `${VAPID_*:-}` forwards empty strings when the keys are not
    // configured; these must read as "off", not fail the min-length check.
    const environment = parseServerEnvironment({
      ...baseEnvironment,
      VAPID_PUBLIC_KEY: '',
      VAPID_PRIVATE_KEY: '',
      VAPID_SUBJECT: '',
    });
    expect(environment.pushEnabled).toBe(false);
    expect(environment.VAPID_PUBLIC_KEY).toBeUndefined();
  });

  it('rejects a partially configured VAPID key set', () => {
    expect(() =>
      parseServerEnvironment({
        ...baseEnvironment,
        VAPID_PUBLIC_KEY: 'a-public-key',
        VAPID_PRIVATE_KEY: '',
        VAPID_SUBJECT: '',
      }),
    ).toThrow(/VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and VAPID_SUBJECT must all be set/);
  });
});
