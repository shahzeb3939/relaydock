import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { argon2id, hash, verify } from 'argon2';

const PASSWORD_HASH_OPTIONS = {
  type: argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function createOpaqueToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString('base64url')}`;
}

export function hashOpaqueToken(token: string, secret: string): string {
  return createHmac('sha256', secret).update(token, 'utf8').digest('hex');
}

export function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export async function hashPassword(password: string): Promise<string> {
  return hash(password, PASSWORD_HASH_OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

export function createPairingCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(8);
  const characters = Array.from(bytes, (byte) => alphabet[byte % alphabet.length]);
  return `${characters.slice(0, 4).join('')}-${characters.slice(4).join('')}`;
}
