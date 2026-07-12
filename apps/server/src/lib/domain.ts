import path from 'node:path';

import { z } from 'zod';

export const environmentNameSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

export const stringArraySchema = z.array(z.string()).max(100);

export function normalizePairingCode(code: string): string {
  const compact = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (compact.length !== 8) return '';
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

export function isPairingCodeUsable(
  pairingCode: { expiresAt: Date; usedAt: Date | null },
  now = new Date(),
): boolean {
  return pairingCode.usedAt === null && pairingCode.expiresAt.getTime() > now.getTime();
}

export function normalizeWorkingDirectory(value: string | undefined): string {
  const directory = value?.trim() ?? '';
  if (directory === '' || directory === '.') return '';
  if (
    directory.includes('\0') ||
    path.posix.isAbsolute(directory) ||
    path.win32.isAbsolute(directory)
  ) {
    throw new Error('Working directory must be relative to the repository.');
  }
  const segments = directory.replaceAll('\\', '/').split('/');
  if (segments.some((segment) => segment === '..')) {
    throw new Error('Working directory cannot leave the repository.');
  }
  const normalized = path.posix.normalize(segments.join('/'));
  return normalized === '.' ? '' : normalized;
}

export interface RetainedChunk {
  id: string;
  byteLength: number;
}

export function chunkIdsToRemove(
  oldestFirst: readonly RetainedChunk[],
  maximumBytes: number,
): string[] {
  const total = oldestFirst.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  let bytesToRemove = Math.max(0, total - maximumBytes);
  const ids: string[] = [];
  for (const chunk of oldestFirst) {
    if (bytesToRemove <= 0) break;
    ids.push(chunk.id);
    bytesToRemove -= chunk.byteLength;
  }
  return ids;
}

export function jsonStringArray(value: unknown, schema = stringArraySchema): string[] {
  return schema.parse(value);
}
