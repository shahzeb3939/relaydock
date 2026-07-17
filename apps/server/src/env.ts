import { relayDockDefaults } from '@relaydock/config';
import { z } from 'zod';

const booleanFromEnvironment = z.enum(['true', 'false']).transform((value) => value === 'true');

const redisUrl = z
  .string()
  .url()
  .refine(
    (value) => {
      const protocol = new URL(value).protocol;
      return protocol === 'redis:' || protocol === 'rediss:';
    },
    { message: 'must use redis:// or rediss://' },
  );

const commaSeparatedOrigins = z.string().transform((value, context) => {
  const origins = value
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  for (const origin of origins) {
    try {
      if (new URL(origin).origin !== origin) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: `${origin} is not an origin` });
      }
    } catch {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `${origin} is not a URL` });
    }
  }

  return origins;
});

const publicUrl = z
  .string()
  .url()
  .transform((value) => new URL(value).origin);

const commaSeparatedEmailDomains = z.string().transform((value, context) => {
  const domains = value
    .split(',')
    .map((domain) => domain.trim().toLowerCase())
    .filter((domain) => domain.length > 0);

  for (const domain of domains) {
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${domain} is not a valid email domain`,
      });
    }
  }

  return domains;
});

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().min(1).default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(relayDockDefaults.serverPort),
    DATABASE_URL: z.string().min(1),
    REDIS_URL: redisUrl.optional(),
    REDIS_NAMESPACE: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9._-]+$/)
      .default('relaydock'),
    RELAY_ACK_TIMEOUT_MS: z.coerce.number().int().min(250).max(10_000).default(2_000),
    CRON_SECRET: z.string().min(32).optional(),
    SESSION_SECRET: z.string().min(32),
    CREDENTIAL_SECRET: z.string().min(32),
    ALLOWED_ORIGINS: commaSeparatedOrigins.default('http://localhost:5173,http://127.0.0.1:5173'),
    ALLOW_REGISTRATION: booleanFromEnvironment.default('false'),
    TRUST_PROXY: booleanFromEnvironment.default('false'),
    SESSION_TTL_HOURS: z.coerce
      .number()
      .int()
      .min(1)
      .max(24 * 365)
      .default(relayDockDefaults.sessionTtlHours),
    PAIRING_CODE_TTL_MINUTES: z.coerce
      .number()
      .int()
      .min(1)
      .max(60)
      .default(relayDockDefaults.pairingCodeTtlMinutes),
    JOB_RETENTION_DAYS: z.coerce
      .number()
      .int()
      .min(1)
      .max(3650)
      .default(relayDockDefaults.jobRetentionDays),
    MAX_RETAINED_OUTPUT_BYTES: z.coerce
      .number()
      .int()
      .min(64 * 1024)
      .max(1024 * 1024 * 1024)
      .default(relayDockDefaults.maxRetainedOutputBytes),
    HEARTBEAT_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(1000)
      .max(300_000)
      .default(relayDockDefaults.heartbeatIntervalMs),
    OFFLINE_AFTER_MS: z.coerce
      .number()
      .int()
      .min(2000)
      .max(900_000)
      .default(relayDockDefaults.offlineAfterMs),
    REPOSITORY_VALIDATION_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1000)
      .max(120_000)
      .default(15_000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    PUBLIC_URL: publicUrl.optional(),
    GOOGLE_CLIENT_ID: z.string().min(1).optional(),
    GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
    GOOGLE_ALLOWED_EMAIL_DOMAINS: commaSeparatedEmailDomains.optional(),
    // Web Push (VAPID) keys enable job notifications. Optional: when unset, the
    // push feature is inert. The private key is a secret; the public key is
    // handed to browsers to build their subscription. See docs/notifications.md.
    VAPID_PUBLIC_KEY: z.string().min(1).optional(),
    VAPID_PRIVATE_KEY: z.string().min(1).optional(),
    VAPID_SUBJECT: z.string().min(1).optional(),
  })
  .superRefine((environment, context) => {
    if (environment.NODE_ENV === 'production' && environment.ALLOWED_ORIGINS.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ALLOWED_ORIGINS'],
        message: 'at least one allowed browser origin is required in production',
      });
    }
    if (environment.OFFLINE_AFTER_MS <= environment.HEARTBEAT_INTERVAL_MS) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['OFFLINE_AFTER_MS'],
        message: 'must be greater than HEARTBEAT_INTERVAL_MS',
      });
    }
    if (
      environment.NODE_ENV === 'production' &&
      environment.SESSION_SECRET === environment.CREDENTIAL_SECRET
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CREDENTIAL_SECRET'],
        message: 'must be distinct from the session pepper in production',
      });
    }
    if (
      (environment.GOOGLE_CLIENT_ID === undefined) !==
      (environment.GOOGLE_CLIENT_SECRET === undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['GOOGLE_CLIENT_SECRET'],
        message:
          'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must both be set to enable Google sign-in',
      });
    }
    if (
      environment.GOOGLE_CLIENT_ID !== undefined &&
      environment.GOOGLE_CLIENT_SECRET !== undefined &&
      environment.PUBLIC_URL === undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PUBLIC_URL'],
        message:
          'PUBLIC_URL is required when Google sign-in is enabled; it builds the OAuth redirect URI',
      });
    }
    // The three VAPID values are all-or-nothing: a partial set cannot sign a
    // push request, so surface it as a configuration error rather than silently
    // disabling notifications.
    const vapidSet = [
      environment.VAPID_PUBLIC_KEY,
      environment.VAPID_PRIVATE_KEY,
      environment.VAPID_SUBJECT,
    ].filter((value) => value !== undefined).length;
    if (vapidSet > 0 && vapidSet < 3) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['VAPID_PRIVATE_KEY'],
        message:
          'VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and VAPID_SUBJECT must all be set to enable push notifications',
      });
    }
    if (
      environment.VAPID_SUBJECT !== undefined &&
      !/^(mailto:|https:\/\/)/.test(environment.VAPID_SUBJECT)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['VAPID_SUBJECT'],
        message: 'VAPID_SUBJECT must be a mailto: address or an https:// URL',
      });
    }
  });

export interface ServerEnvironment extends z.infer<typeof environmentSchema> {
  cookieSecure: boolean;
  googleEnabled: boolean;
  pushEnabled: boolean;
}

export function parseServerEnvironment(source: NodeJS.ProcessEnv): ServerEnvironment {
  const sessionSecret = source.RELAYDOCK_SESSION_PEPPER ?? source.SESSION_SECRET;
  const credentialSecret =
    source.RELAYDOCK_CREDENTIAL_PEPPER ?? source.CREDENTIAL_SECRET ?? sessionSecret;
  const normalized: NodeJS.ProcessEnv = {
    ...source,
    HOST: source.RELAYDOCK_HOST ?? source.HOST,
    PORT: source.RELAYDOCK_PORT ?? source.PORT,
    REDIS_URL: source.RELAYDOCK_REDIS_URL ?? source.REDIS_URL ?? source.KV_URL,
    REDIS_NAMESPACE: source.RELAYDOCK_REDIS_NAMESPACE ?? source.REDIS_NAMESPACE,
    RELAY_ACK_TIMEOUT_MS: source.RELAYDOCK_RELAY_ACK_TIMEOUT_MS ?? source.RELAY_ACK_TIMEOUT_MS,
    CRON_SECRET: source.RELAYDOCK_CRON_SECRET ?? source.CRON_SECRET,
    SESSION_SECRET: sessionSecret,
    CREDENTIAL_SECRET: credentialSecret,
    ALLOWED_ORIGINS:
      source.RELAYDOCK_ALLOWED_ORIGINS ?? source.RELAYDOCK_WEB_ORIGIN ?? source.ALLOWED_ORIGINS,
    ALLOW_REGISTRATION: source.RELAYDOCK_ALLOW_REGISTRATION ?? source.ALLOW_REGISTRATION,
    TRUST_PROXY: source.RELAYDOCK_TRUST_PROXY ?? source.TRUST_PROXY,
    SESSION_TTL_HOURS: source.RELAYDOCK_SESSION_TTL_HOURS ?? source.SESSION_TTL_HOURS,
    PAIRING_CODE_TTL_MINUTES:
      source.RELAYDOCK_PAIRING_CODE_TTL_MINUTES ?? source.PAIRING_CODE_TTL_MINUTES,
    JOB_RETENTION_DAYS: source.RELAYDOCK_JOB_RETENTION_DAYS ?? source.JOB_RETENTION_DAYS,
    MAX_RETAINED_OUTPUT_BYTES:
      source.RELAYDOCK_MAX_JOB_OUTPUT_BYTES ?? source.MAX_RETAINED_OUTPUT_BYTES,
    HEARTBEAT_INTERVAL_MS: source.RELAYDOCK_HEARTBEAT_INTERVAL_MS ?? source.HEARTBEAT_INTERVAL_MS,
    OFFLINE_AFTER_MS: source.RELAYDOCK_OFFLINE_AFTER_MS ?? source.OFFLINE_AFTER_MS,
    REPOSITORY_VALIDATION_TIMEOUT_MS:
      source.RELAYDOCK_REPOSITORY_VALIDATION_TIMEOUT_MS ?? source.REPOSITORY_VALIDATION_TIMEOUT_MS,
    LOG_LEVEL: source.RELAYDOCK_LOG_LEVEL ?? source.LOG_LEVEL,
    PUBLIC_URL: source.RELAYDOCK_PUBLIC_URL ?? source.PUBLIC_URL,
    GOOGLE_CLIENT_ID: source.RELAYDOCK_GOOGLE_CLIENT_ID ?? source.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: source.RELAYDOCK_GOOGLE_CLIENT_SECRET ?? source.GOOGLE_CLIENT_SECRET,
    GOOGLE_ALLOWED_EMAIL_DOMAINS:
      source.RELAYDOCK_GOOGLE_ALLOWED_EMAIL_DOMAINS ?? source.GOOGLE_ALLOWED_EMAIL_DOMAINS,
    VAPID_PUBLIC_KEY: source.RELAYDOCK_VAPID_PUBLIC_KEY ?? source.VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY: source.RELAYDOCK_VAPID_PRIVATE_KEY ?? source.VAPID_PRIVATE_KEY,
    VAPID_SUBJECT: source.RELAYDOCK_VAPID_SUBJECT ?? source.VAPID_SUBJECT,
  };
  const environment = environmentSchema.parse(normalized);
  return {
    ...environment,
    cookieSecure: environment.NODE_ENV === 'production',
    googleEnabled:
      environment.GOOGLE_CLIENT_ID !== undefined && environment.GOOGLE_CLIENT_SECRET !== undefined,
    pushEnabled:
      environment.VAPID_PUBLIC_KEY !== undefined &&
      environment.VAPID_PRIVATE_KEY !== undefined &&
      environment.VAPID_SUBJECT !== undefined,
  };
}
