import type { JobStatus } from '@relaydock/protocol';
import type { FastifyBaseLogger } from 'fastify';
// Default import: web-push is CommonJS, and under native ESM a namespace import
// (`import * as webpush`) only exposes the subset of module.exports that
// cjs-module-lexer detects — sendNotification/setVapidDetails come back
// undefined at runtime even though the types resolve. The default import binds
// the whole module.exports object, so every member is present.
import webpush from 'web-push';

import type { DatabaseClient } from '../prisma.js';

// Hosts operated by the browser push services. Subscription endpoints are
// validated against this before being stored, so the server can only ever be
// asked to POST to a real push provider — not an arbitrary internal host (SSRF).
const ALLOWED_PUSH_HOSTS = [
  'fcm.googleapis.com',
  'android.googleapis.com',
  '.push.services.mozilla.com',
  '.notify.windows.com',
  'web.push.apple.com',
] as const;

export function isAllowedPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return ALLOWED_PUSH_HOSTS.some((allowed) =>
    allowed.startsWith('.') ? host.endsWith(allowed) : host === allowed,
  );
}

// The job states worth interrupting the user for. Cancellations are user-driven
// (no surprise to notify about) and `disconnected` is frequently transient (the
// agent usually reconnects), so both are intentionally excluded.
const NOTIFIABLE_STATUSES: ReadonlySet<JobStatus> = new Set([
  'waiting_for_input',
  'completed',
  'failed',
]);

export interface JobNotificationInput {
  jobId: string;
  status: JobStatus;
  exitCode: number | null;
  repositoryName: string;
}

export interface JobNotificationPayload {
  title: string;
  body: string;
  tag: string;
  url: string;
  jobId: string;
  status: JobStatus;
}

// Pure: maps a job transition to the notification a browser should show, or
// null when the status is not notify-worthy. The body is deliberately limited
// to the repository name — the raw command can carry secrets and would land on
// a lock screen, so identity comes from the repo and the tap-through opens the
// full session.
export function buildJobNotification(input: JobNotificationInput): JobNotificationPayload | null {
  if (!NOTIFIABLE_STATUSES.has(input.status)) return null;
  const base = {
    tag: `relaydock-job-${input.jobId}`,
    url: `/jobs/${input.jobId}`,
    jobId: input.jobId,
    status: input.status,
  };
  const body = input.repositoryName;
  switch (input.status) {
    case 'waiting_for_input':
      return { ...base, title: 'Waiting for your input', body };
    case 'completed':
      return {
        ...base,
        title:
          input.exitCode !== null && input.exitCode !== 0
            ? `Job finished · exit ${input.exitCode}`
            : 'Job completed',
        body,
      };
    case 'failed':
      return { ...base, title: 'Job failed', body };
    default:
      return null;
  }
}

// The narrow surface JobService depends on, so the transition path stays
// decoupled from the push implementation (and easy to fake in tests).
export interface JobPushNotifier {
  notifyJobTransition(job: {
    id: string;
    userId: string;
    status: JobStatus;
    exitCode: number | null;
    repositoryId: string;
  }): void;
}

export interface PushVapidDetails {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export interface PushServiceOptions {
  database: DatabaseClient;
  logger: FastifyBaseLogger;
  vapid: PushVapidDetails | null;
}

export class PushService implements JobPushNotifier {
  readonly enabled: boolean;
  readonly publicKey: string | null;
  private readonly database: DatabaseClient;
  private readonly logger: FastifyBaseLogger;

  constructor(options: PushServiceOptions) {
    this.database = options.database;
    this.logger = options.logger;
    this.enabled = options.vapid !== null;
    this.publicKey = options.vapid?.publicKey ?? null;
    if (options.vapid !== null) {
      webpush.setVapidDetails(
        options.vapid.subject,
        options.vapid.publicKey,
        options.vapid.privateKey,
      );
    }
  }

  // Fire-and-forget: a failure to notify must never affect the job transition
  // that triggered it, so errors are contained here and only logged.
  notifyJobTransition(job: {
    id: string;
    userId: string;
    status: JobStatus;
    exitCode: number | null;
    repositoryId: string;
  }): void {
    if (!this.enabled) return;
    if (!NOTIFIABLE_STATUSES.has(job.status)) return;
    void this.deliver(job).catch((error: unknown) => {
      this.logger.warn(
        { jobId: job.id, errorMessage: error instanceof Error ? error.message : String(error) },
        'push notification delivery failed',
      );
    });
  }

  private async deliver(job: {
    id: string;
    userId: string;
    status: JobStatus;
    exitCode: number | null;
    repositoryId: string;
  }): Promise<void> {
    const [subscriptions, repository] = await Promise.all([
      this.database.pushSubscription.findMany({ where: { userId: job.userId } }),
      this.database.repository.findUnique({
        where: { id: job.repositoryId },
        select: { name: true },
      }),
    ]);
    if (subscriptions.length === 0) return;
    const payload = buildJobNotification({
      jobId: job.id,
      status: job.status,
      exitCode: job.exitCode,
      repositoryName: repository?.name ?? 'a repository',
    });
    if (payload === null) return;
    const serialized = JSON.stringify(payload);
    await Promise.all(
      subscriptions.map((subscription) => this.sendOne(subscription, serialized)),
    );
  }

  private async sendOne(
    subscription: { id: string; endpoint: string; p256dh: string; auth: string },
    serialized: string,
  ): Promise<void> {
    try {
      await webpush.sendNotification(
        {
          endpoint: subscription.endpoint,
          keys: { p256dh: subscription.p256dh, auth: subscription.auth },
        },
        serialized,
        // Bound a slow/hanging push endpoint so a single send can't tie up the
        // (serverless) invocation.
        { TTL: 600, timeout: 10_000 },
      );
      await this.database.pushSubscription
        .update({ where: { id: subscription.id }, data: { lastNotifiedAt: new Date() } })
        .catch(() => undefined);
    } catch (error: unknown) {
      const statusCode = error instanceof webpush.WebPushError ? error.statusCode : undefined;
      // 404/410 mean the endpoint is permanently gone (unsubscribed or expired
      // by the push service). Prune it so it is never retried.
      if (statusCode === 404 || statusCode === 410) {
        await this.database.pushSubscription
          .delete({ where: { id: subscription.id } })
          .catch(() => undefined);
        return;
      }
      // Log only non-sensitive fields — the WebPushError carries the endpoint
      // (a bearer-like capability URL) plus provider headers/body, which must
      // not land in logs.
      this.logger.warn(
        {
          statusCode,
          subscriptionId: subscription.id,
          errorMessage: error instanceof Error ? error.message : String(error),
        },
        'push send failed',
      );
    }
  }
}
