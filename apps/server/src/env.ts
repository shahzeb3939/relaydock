import { relayDockDefaults } from '@relaydock/config';
import { z } from 'zod';

const booleanFromEnvironment = z.enum(['true', 'false']).transform((value) => value === 'true');

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

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().min(1).default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(relayDockDefaults.serverPort),
    DATABASE_URL: z.string().min(1),
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
  });

export interface ServerEnvironment extends z.infer<typeof environmentSchema> {
  cookieSecure: boolean;
}

export function parseServerEnvironment(source: NodeJS.ProcessEnv): ServerEnvironment {
  const sessionSecret = source.RELAYDOCK_SESSION_PEPPER ?? source.SESSION_SECRET;
  const credentialSecret =
    source.RELAYDOCK_CREDENTIAL_PEPPER ?? source.CREDENTIAL_SECRET ?? sessionSecret;
  const normalized: NodeJS.ProcessEnv = {
    ...source,
    HOST: source.RELAYDOCK_HOST ?? source.HOST,
    PORT: source.RELAYDOCK_PORT ?? source.PORT,
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
  };
  const environment = environmentSchema.parse(normalized);
  return { ...environment, cookieSecure: environment.NODE_ENV === 'production' };
}
