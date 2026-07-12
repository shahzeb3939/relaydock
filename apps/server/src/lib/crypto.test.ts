import { describe, expect, it } from 'vitest';

import { createOpaqueToken, hashOpaqueToken, hashPassword, verifyPassword } from './crypto.js';

describe('credential protection', () => {
  it('hashes and verifies passwords with Argon2id', async () => {
    const passwordHash = await hashPassword('correct horse battery staple');
    expect(passwordHash).toMatch(/^\$argon2id\$/);
    await expect(verifyPassword(passwordHash, 'correct horse battery staple')).resolves.toBe(true);
    await expect(verifyPassword(passwordHash, 'incorrect password')).resolves.toBe(false);
  });

  it('creates opaque credentials and only stores a keyed digest', () => {
    const token = createOpaqueToken('rdc');
    const digest = hashOpaqueToken(token, 'test-secret');
    expect(token).toMatch(/^rdc_[A-Za-z0-9_-]+$/);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(digest).not.toContain(token);
    expect(hashOpaqueToken(token, 'test-secret')).toBe(digest);
    expect(hashOpaqueToken(token, 'different-secret')).not.toBe(digest);
  });
});
