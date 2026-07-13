import { Prisma } from '@prisma/client';

import type { DatabaseClient } from '../prisma.js';
import { AppError } from './errors.js';

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_SCOPE = 'openid email profile';
const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
const CLOCK_SKEW_MS = 5 * 60 * 1000;

export interface GoogleProfile {
  sub: string;
  email: string;
  emailVerified: boolean;
  name?: string;
}

/**
 * Builds the Google authorization URL that starts the OAuth 2.0 authorization
 * code flow. `state` is an unguessable value we also store in a cookie so the
 * callback can prove the request originated from us.
 */
export function buildGoogleAuthorizationUrl(options: {
  clientId: string;
  redirectUri: string;
  state: string;
  hostedDomainHint?: string;
}): string {
  const url = new URL(GOOGLE_AUTH_ENDPOINT);
  url.searchParams.set('client_id', options.clientId);
  url.searchParams.set('redirect_uri', options.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', GOOGLE_SCOPE);
  url.searchParams.set('state', options.state);
  url.searchParams.set('access_type', 'online');
  url.searchParams.set('prompt', 'select_account');
  // A single allowed domain lets Google pre-filter the account chooser. It is a
  // hint only; the domain is still enforced server-side against the id token.
  if (options.hostedDomainHint !== undefined) {
    url.searchParams.set('hd', options.hostedDomainHint);
  }
  return url.toString();
}

/**
 * Exchanges an authorization code for Google's response and returns the id
 * token. The exchange happens over a TLS connection we initiate and is
 * authenticated with the client secret, so the returned token is trusted.
 */
export async function exchangeCodeForIdToken(
  options: { code: string; clientId: string; clientSecret: string; redirectUri: string },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const body = new URLSearchParams({
    code: options.code,
    client_id: options.clientId,
    client_secret: options.clientSecret,
    redirect_uri: options.redirectUri,
    grant_type: 'authorization_code',
  });

  let response: Response;
  try {
    response = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body,
    });
  } catch {
    throw new AppError(502, 'GOOGLE_UNREACHABLE', 'Could not reach Google to complete sign-in.');
  }
  if (!response.ok) {
    throw new AppError(502, 'GOOGLE_TOKEN_EXCHANGE_FAILED', 'Google rejected the sign-in attempt.');
  }
  const payload = (await response.json()) as { id_token?: unknown };
  if (typeof payload.id_token !== 'string' || payload.id_token === '') {
    throw new AppError(502, 'GOOGLE_TOKEN_MISSING', 'Google did not return an identity token.');
  }
  return payload.id_token;
}

/**
 * Decodes and validates the claims of a Google id token. The token is received
 * directly from Google's token endpoint over authenticated TLS, so per Google's
 * guidance the signature does not need re-verification here; the issuer,
 * audience, and expiry are still checked as defence in depth.
 */
export function parseGoogleIdToken(
  idToken: string,
  expectedAudience: string,
  nowMs: number,
): GoogleProfile {
  const invalid = (): never => {
    throw new AppError(502, 'GOOGLE_TOKEN_INVALID', 'Google returned an invalid identity token.');
  };

  const segments = idToken.split('.');
  const payloadSegment = segments[1];
  if (segments.length !== 3 || payloadSegment === undefined) return invalid();

  let claims: Record<string, unknown>;
  try {
    const decoded = Buffer.from(payloadSegment, 'base64url').toString('utf8');
    const parsed = JSON.parse(decoded) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return invalid();
    claims = parsed as Record<string, unknown>;
  } catch {
    return invalid();
  }

  if (typeof claims.iss !== 'string' || !GOOGLE_ISSUERS.has(claims.iss)) return invalid();
  if (claims.aud !== expectedAudience) return invalid();
  if (typeof claims.exp !== 'number' || claims.exp * 1000 + CLOCK_SKEW_MS < nowMs) return invalid();

  const sub = typeof claims.sub === 'string' ? claims.sub : '';
  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
  if (sub === '' || email === '') return invalid();

  const emailVerified = claims.email_verified === true || claims.email_verified === 'true';
  const name = typeof claims.name === 'string' ? claims.name : undefined;
  return { sub, email, emailVerified, ...(name === undefined ? {} : { name }) };
}

/**
 * Returns whether an email address may create a new account given the allowed
 * domain list. An empty list means any domain is accepted.
 */
export function isEmailDomainAllowed(email: string, allowedEmailDomains: string[]): boolean {
  if (allowedEmailDomains.length === 0) return true;
  const atIndex = email.lastIndexOf('@');
  if (atIndex === -1) return false;
  const domain = email.slice(atIndex + 1).toLowerCase();
  return allowedEmailDomains.includes(domain);
}

export interface ResolvedAccount {
  user: { id: string; email: string; createdAt: Date };
  created: boolean;
}

type UserDatabase = Pick<DatabaseClient, 'user'>;

/**
 * Resolves the local account for a verified Google profile, creating or linking
 * one as needed.
 *
 * Matching order:
 *  1. By stable Google subject id — an account already linked to this Google
 *     identity signs straight in.
 *  2. By email, but only when Google reports the address verified — otherwise an
 *     attacker could register an unverified Google address matching a password
 *     account and take it over. A verified match links the Google id in place.
 *  3. Otherwise a new account is created, provided the email is verified and its
 *     domain is allowed.
 */
export async function resolveGoogleAccount(
  database: UserDatabase,
  profile: GoogleProfile,
  options: { allowedEmailDomains: string[] },
): Promise<ResolvedAccount> {
  const existingBySub = await database.user.findUnique({ where: { googleSub: profile.sub } });
  if (existingBySub !== null) {
    return { user: existingBySub, created: false };
  }

  if (profile.emailVerified) {
    const existingByEmail = await database.user.findUnique({ where: { email: profile.email } });
    if (existingByEmail !== null) {
      if (existingByEmail.googleSub !== null && existingByEmail.googleSub !== profile.sub) {
        throw new AppError(
          409,
          'ACCOUNT_LINK_CONFLICT',
          'This email is already linked to a different Google account.',
        );
      }
      const linked = await database.user.update({
        where: { id: existingByEmail.id },
        data: { googleSub: profile.sub },
      });
      return { user: linked, created: false };
    }
  }

  if (!profile.emailVerified) {
    throw new AppError(
      403,
      'GOOGLE_EMAIL_UNVERIFIED',
      'Your Google account email address is not verified.',
    );
  }
  if (!isEmailDomainAllowed(profile.email, options.allowedEmailDomains)) {
    throw new AppError(
      403,
      'EMAIL_DOMAIN_NOT_ALLOWED',
      'Sign-in with this email domain is not allowed.',
    );
  }

  try {
    const created = await database.user.create({
      data: { email: profile.email, googleSub: profile.sub },
    });
    return { user: created, created: true };
  } catch (error) {
    // A concurrent callback for the same identity may have won the race; fall
    // back to the account it created rather than surfacing a unique-constraint
    // error.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const raced = await database.user.findUnique({ where: { googleSub: profile.sub } });
      if (raced !== null) return { user: raced, created: false };
    }
    throw error;
  }
}
