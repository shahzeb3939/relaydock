import { describe, expect, it } from 'vitest';

import {
  chunkIdsToRemove,
  isPairingCodeUsable,
  normalizePairingCode,
  normalizeWorkingDirectory,
} from './domain.js';

describe('pairing codes', () => {
  it('normalizes human-entered codes and enforces one-time expiration', () => {
    expect(normalizePairingCode('abcd efgh')).toBe('ABCD-EFGH');
    const now = new Date('2026-07-12T12:00:00.000Z');
    expect(
      isPairingCodeUsable({ usedAt: null, expiresAt: new Date('2026-07-12T12:10:00.000Z') }, now),
    ).toBe(true);
    expect(
      isPairingCodeUsable({ usedAt: now, expiresAt: new Date('2026-07-12T12:10:00.000Z') }, now),
    ).toBe(false);
    expect(isPairingCodeUsable({ usedAt: null, expiresAt: now }, now)).toBe(false);
  });
});

describe('repository working directories', () => {
  it('accepts normalized relative paths', () => {
    expect(normalizeWorkingDirectory('packages/./web')).toBe('packages/web');
    expect(normalizeWorkingDirectory('.')).toBe('');
  });

  it('rejects traversal and absolute paths on Unix and Windows', () => {
    expect(() => normalizeWorkingDirectory('../outside')).toThrow();
    expect(() => normalizeWorkingDirectory('/tmp/outside')).toThrow();
    expect(() => normalizeWorkingDirectory('C:\\outside')).toThrow();
  });
});

describe('output retention', () => {
  it('removes complete oldest chunks until the byte budget is met', () => {
    expect(
      chunkIdsToRemove(
        [
          { id: 'first', byteLength: 60 },
          { id: 'second', byteLength: 50 },
          { id: 'third', byteLength: 40 },
        ],
        100,
      ),
    ).toEqual(['first']);
  });
});
