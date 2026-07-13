import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import type { DatabaseClient } from '../prisma.js';
import { AppError } from './errors.js';
import {
  buildGoogleAuthorizationUrl,
  isEmailDomainAllowed,
  parseGoogleIdToken,
  resolveGoogleAccount,
} from './google-oauth.js';

const NOW_MS = 1_700_000_000_000;

function encodeSegment(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function idToken(claims: Record<string, unknown>): string {
  return `${encodeSegment({ alg: 'RS256' })}.${encodeSegment(claims)}.signature`;
}

function validClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: 'https://accounts.google.com',
    aud: 'client-123',
    exp: Math.floor(NOW_MS / 1000) + 3600,
    sub: '1029384756',
    email: 'Person@Emumba.com',
    email_verified: true,
    name: 'A Person',
    ...overrides,
  };
}

describe('buildGoogleAuthorizationUrl', () => {
  it('includes the required parameters and omits the hint when absent', () => {
    const url = new URL(
      buildGoogleAuthorizationUrl({
        clientId: 'client-123',
        redirectUri: 'https://relaydock.example/api/auth/google/callback',
        state: 'state-token',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe('client-123');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://relaydock.example/api/auth/google/callback',
    );
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('openid email profile');
    expect(url.searchParams.get('state')).toBe('state-token');
    expect(url.searchParams.has('hd')).toBe(false);
  });

  it('passes the hosted-domain hint when a single domain is allowed', () => {
    const url = new URL(
      buildGoogleAuthorizationUrl({
        clientId: 'client-123',
        redirectUri: 'https://relaydock.example/api/auth/google/callback',
        state: 'state-token',
        hostedDomainHint: 'emumba.com',
      }),
    );
    expect(url.searchParams.get('hd')).toBe('emumba.com');
  });
});

describe('parseGoogleIdToken', () => {
  it('extracts and normalizes claims from a valid token', () => {
    const profile = parseGoogleIdToken(idToken(validClaims()), 'client-123', NOW_MS);
    expect(profile).toEqual({
      sub: '1029384756',
      email: 'person@emumba.com',
      emailVerified: true,
      name: 'A Person',
    });
  });

  it('reports an unverified email without throwing', () => {
    const profile = parseGoogleIdToken(
      idToken(validClaims({ email_verified: false })),
      'client-123',
      NOW_MS,
    );
    expect(profile.emailVerified).toBe(false);
  });

  it('rejects a token for a different audience', () => {
    expect(() => parseGoogleIdToken(idToken(validClaims()), 'other-client', NOW_MS)).toThrow(
      AppError,
    );
  });

  it('rejects an unexpected issuer', () => {
    expect(() =>
      parseGoogleIdToken(
        idToken(validClaims({ iss: 'https://evil.example' })),
        'client-123',
        NOW_MS,
      ),
    ).toThrow(AppError);
  });

  it('rejects an expired token beyond the clock-skew allowance', () => {
    const claims = validClaims({ exp: Math.floor(NOW_MS / 1000) - 3600 });
    expect(() => parseGoogleIdToken(idToken(claims), 'client-123', NOW_MS)).toThrow(AppError);
  });

  it('rejects a token missing required claims', () => {
    const claims = validClaims();
    delete claims.sub;
    expect(() => parseGoogleIdToken(idToken(claims), 'client-123', NOW_MS)).toThrow(AppError);
  });

  it('rejects a structurally malformed token', () => {
    expect(() => parseGoogleIdToken('not.a.valid.jwt', 'client-123', NOW_MS)).toThrow(AppError);
    expect(() => parseGoogleIdToken('missing-segments', 'client-123', NOW_MS)).toThrow(AppError);
  });
});

describe('isEmailDomainAllowed', () => {
  it('allows any domain when the list is empty', () => {
    expect(isEmailDomainAllowed('anyone@gmail.com', [])).toBe(true);
  });

  it('matches the domain case-insensitively', () => {
    expect(isEmailDomainAllowed('person@Emumba.com', ['emumba.com'])).toBe(true);
  });

  it('rejects a domain outside the list', () => {
    expect(isEmailDomainAllowed('person@gmail.com', ['emumba.com'])).toBe(false);
  });

  it('rejects an address without a domain', () => {
    expect(isEmailDomainAllowed('not-an-email', ['emumba.com'])).toBe(false);
  });
});

interface UserRow {
  id: string;
  email: string;
  createdAt: Date;
  googleSub: string | null;
  passwordHash: string | null;
}

function row(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: 'user-1',
    email: 'person@emumba.com',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    googleSub: null,
    passwordHash: 'hash',
    ...overrides,
  };
}

function userDatabase(seed: { bySub?: UserRow | null; byEmail?: UserRow | null }) {
  const findUnique = vi.fn(async (arguments_: { where: Record<string, unknown> }) => {
    if ('googleSub' in arguments_.where) return seed.bySub ?? null;
    if ('email' in arguments_.where) return seed.byEmail ?? null;
    return null;
  });
  const update = vi.fn(async (arguments_: { where: { id: string }; data: { googleSub: string } }) =>
    row({ id: arguments_.where.id, googleSub: arguments_.data.googleSub }),
  );
  const create = vi.fn(async (arguments_: { data: { email: string; googleSub: string } }) =>
    row({
      id: 'created-user',
      email: arguments_.data.email,
      googleSub: arguments_.data.googleSub,
      passwordHash: null,
    }),
  );
  const database = { user: { findUnique, update, create } } as unknown as Pick<
    DatabaseClient,
    'user'
  >;
  return { database, findUnique, update, create };
}

const verifiedProfile = {
  sub: '1029384756',
  email: 'person@emumba.com',
  emailVerified: true,
} as const;

describe('resolveGoogleAccount', () => {
  it('signs in an account already linked to the Google subject', async () => {
    const { database, create, update } = userDatabase({ bySub: row({ googleSub: '1029384756' }) });
    const result = await resolveGoogleAccount(database, verifiedProfile, {
      allowedEmailDomains: [],
    });
    expect(result.created).toBe(false);
    expect(result.user.id).toBe('user-1');
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('links a verified email to an existing password account', async () => {
    const { database, update, create } = userDatabase({
      bySub: null,
      byEmail: row({ googleSub: null }),
    });
    const result = await resolveGoogleAccount(database, verifiedProfile, {
      allowedEmailDomains: ['emumba.com'],
    });
    expect(update).toHaveBeenCalledOnce();
    expect(result.created).toBe(false);
    expect(result.user.googleSub).toBe('1029384756');
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses to relink an email owned by a different Google subject', async () => {
    const { database } = userDatabase({
      bySub: null,
      byEmail: row({ googleSub: 'different-sub' }),
    });
    await expect(
      resolveGoogleAccount(database, verifiedProfile, { allowedEmailDomains: [] }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_LINK_CONFLICT' });
  });

  it('does not link by email when Google has not verified it', async () => {
    const { database, update, create } = userDatabase({
      bySub: null,
      byEmail: row({ googleSub: null }),
    });
    await expect(
      resolveGoogleAccount(
        database,
        { ...verifiedProfile, emailVerified: false },
        { allowedEmailDomains: [] },
      ),
    ).rejects.toMatchObject({ code: 'GOOGLE_EMAIL_UNVERIFIED' });
    expect(update).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('creates a new account when the domain is allowed', async () => {
    const { database, create } = userDatabase({ bySub: null, byEmail: null });
    const result = await resolveGoogleAccount(database, verifiedProfile, {
      allowedEmailDomains: ['emumba.com'],
    });
    expect(create).toHaveBeenCalledOnce();
    expect(result.created).toBe(true);
    expect(result.user.email).toBe('person@emumba.com');
  });

  it('rejects a new account whose domain is not allowed', async () => {
    const { database, create } = userDatabase({ bySub: null, byEmail: null });
    await expect(
      resolveGoogleAccount(
        database,
        { ...verifiedProfile, email: 'outsider@gmail.com' },
        { allowedEmailDomains: ['emumba.com'] },
      ),
    ).rejects.toMatchObject({ code: 'EMAIL_DOMAIN_NOT_ALLOWED' });
    expect(create).not.toHaveBeenCalled();
  });

  it('falls back to the raced account when creation hits a unique conflict', async () => {
    const raced = row({ id: 'raced-user', googleSub: '1029384756' });
    const findUnique = vi
      .fn()
      .mockResolvedValueOnce(null) // initial lookup by googleSub
      .mockResolvedValueOnce(null) // lookup by verified email
      .mockResolvedValueOnce(raced); // retry lookup by googleSub after the conflict
    const create = vi.fn().mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('conflict', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    const update = vi.fn();
    const database = { user: { findUnique, update, create } } as unknown as Pick<
      DatabaseClient,
      'user'
    >;
    const result = await resolveGoogleAccount(database, verifiedProfile, {
      allowedEmailDomains: [],
    });
    expect(result.created).toBe(false);
    expect(result.user.id).toBe('raced-user');
  });
});
