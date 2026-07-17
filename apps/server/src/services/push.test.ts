import type { FastifyBaseLogger } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DatabaseClient } from '../prisma.js';

// web-push performs real network + crypto work, so it is stubbed. The stubbed
// WebPushError must be the same class the service compares against with
// instanceof, so it is shared through the mock module.
const { sendNotification, setVapidDetails, MockWebPushError } = vi.hoisted(() => {
  class MockWebPushError extends Error {
    statusCode: number;
    constructor(message: string, statusCode: number) {
      super(message);
      this.name = 'WebPushError';
      this.statusCode = statusCode;
    }
  }
  return { sendNotification: vi.fn(), setVapidDetails: vi.fn(), MockWebPushError };
});

// web-push is CommonJS: mock it with a `default` export (plus named) so it
// matches how the service consumes it under native-ESM interop.
vi.mock('web-push', () => {
  const mod = { setVapidDetails, sendNotification, WebPushError: MockWebPushError };
  return { ...mod, default: mod };
});

import { buildJobNotification, isAllowedPushEndpoint, PushService } from './push.js';

const logger = { warn: vi.fn() } as unknown as FastifyBaseLogger;
const vapid = { publicKey: 'pk', privateKey: 'sk', subject: 'mailto:ops@example.com' };

describe('buildJobNotification', () => {
  it('names the exact notification for each notify-worthy status', () => {
    expect(
      buildJobNotification({
        jobId: 'j1',
        status: 'waiting_for_input',
        exitCode: null,
        repositoryName: 'relaydock',
      }),
    ).toEqual({
      title: 'Waiting for your input',
      body: 'relaydock',
      tag: 'relaydock-job-j1',
      url: '/jobs/j1',
      jobId: 'j1',
      status: 'waiting_for_input',
    });

    expect(
      buildJobNotification({ jobId: 'j1', status: 'completed', exitCode: 0, repositoryName: 'r' })
        ?.title,
    ).toBe('Job completed');
    expect(
      buildJobNotification({ jobId: 'j1', status: 'completed', exitCode: 2, repositoryName: 'r' })
        ?.title,
    ).toBe('Job finished · exit 2');
    expect(
      buildJobNotification({ jobId: 'j1', status: 'failed', exitCode: null, repositoryName: 'r' })
        ?.title,
    ).toBe('Job failed');
  });

  it('never keeps the raw command — the body is only the repository name', () => {
    const payload = buildJobNotification({
      jobId: 'j1',
      status: 'failed',
      exitCode: null,
      repositoryName: 'relaydock',
    });
    expect(payload?.body).toBe('relaydock');
  });

  it('returns null for statuses that must not interrupt the user', () => {
    for (const status of ['queued', 'dispatched', 'running', 'cancelled', 'disconnected'] as const) {
      expect(
        buildJobNotification({ jobId: 'j1', status, exitCode: null, repositoryName: 'r' }),
      ).toBeNull();
    }
  });
});

describe('isAllowedPushEndpoint', () => {
  it('accepts the real push provider hosts over https', () => {
    for (const endpoint of [
      'https://fcm.googleapis.com/fcm/send/abc123',
      'https://updates.push.services.mozilla.com/wpush/v2/xyz',
      'https://web.push.apple.com/QABC',
      'https://db5p.notify.windows.com/w/?token=abc',
    ]) {
      expect(isAllowedPushEndpoint(endpoint)).toBe(true);
    }
  });

  it('rejects arbitrary, private, non-https, and look-alike hosts (SSRF guard)', () => {
    for (const endpoint of [
      'https://10.0.0.5:8443/internal',
      'https://169.254.169.254/latest/meta-data',
      'https://localhost/x',
      'http://fcm.googleapis.com/fcm/send/abc', // not https
      'https://fcm.googleapis.com.evil.com/x', // suffix look-alike
      'https://evil.com/x',
      'not-a-url',
    ]) {
      expect(isAllowedPushEndpoint(endpoint)).toBe(false);
    }
  });
});

describe('PushService', () => {
  beforeEach(() => {
    sendNotification.mockReset();
    setVapidDetails.mockReset();
  });

  function fakeDatabase(subscriptions: Array<{ id: string; endpoint: string }>) {
    return {
      pushSubscription: {
        findMany: vi.fn().mockResolvedValue(
          subscriptions.map((subscription) => ({
            ...subscription,
            p256dh: 'p256dh',
            auth: 'auth',
          })),
        ),
        update: vi.fn().mockResolvedValue({}),
        delete: vi.fn().mockResolvedValue({}),
      },
      repository: { findUnique: vi.fn().mockResolvedValue({ name: 'relaydock' }) },
    };
  }

  it('does nothing when push is not configured', () => {
    const database = fakeDatabase([{ id: 's1', endpoint: 'https://push.example/1' }]);
    const service = new PushService({
      database: database as unknown as DatabaseClient,
      logger,
      vapid: null,
    });
    expect(service.enabled).toBe(false);
    service.notifyJobTransition({
      id: 'j1',
      userId: 'u1',
      status: 'completed',
      exitCode: 0,
      repositoryId: 'r1',
    });
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('sends to every subscription and records the delivery', async () => {
    const database = fakeDatabase([
      { id: 's1', endpoint: 'https://push.example/1' },
      { id: 's2', endpoint: 'https://push.example/2' },
    ]);
    sendNotification.mockResolvedValue({});
    const service = new PushService({
      database: database as unknown as DatabaseClient,
      logger,
      vapid,
    });
    service.notifyJobTransition({
      id: 'j1',
      userId: 'u1',
      status: 'waiting_for_input',
      exitCode: null,
      repositoryId: 'r1',
    });
    await vi.waitFor(() => expect(sendNotification).toHaveBeenCalledTimes(2));
    expect(database.pushSubscription.update).toHaveBeenCalledTimes(2);
    expect(database.pushSubscription.delete).not.toHaveBeenCalled();
  });

  it('prunes a subscription the push service reports as gone (410)', async () => {
    const database = fakeDatabase([{ id: 's1', endpoint: 'https://push.example/1' }]);
    sendNotification.mockRejectedValueOnce(new MockWebPushError('gone', 410));
    const service = new PushService({
      database: database as unknown as DatabaseClient,
      logger,
      vapid,
    });
    service.notifyJobTransition({
      id: 'j1',
      userId: 'u1',
      status: 'completed',
      exitCode: 0,
      repositoryId: 'r1',
    });
    await vi.waitFor(() =>
      expect(database.pushSubscription.delete).toHaveBeenCalledWith({ where: { id: 's1' } }),
    );
    expect(database.pushSubscription.update).not.toHaveBeenCalled();
  });

  it('keeps a subscription on a transient send error (500)', async () => {
    const database = fakeDatabase([{ id: 's1', endpoint: 'https://push.example/1' }]);
    sendNotification.mockRejectedValueOnce(new MockWebPushError('server error', 500));
    const service = new PushService({
      database: database as unknown as DatabaseClient,
      logger,
      vapid,
    });
    service.notifyJobTransition({
      id: 'j1',
      userId: 'u1',
      status: 'failed',
      exitCode: null,
      repositoryId: 'r1',
    });
    await vi.waitFor(() => expect(sendNotification).toHaveBeenCalledTimes(1));
    expect(database.pushSubscription.delete).not.toHaveBeenCalled();
  });

  it('never sends for a non-notify-worthy status', () => {
    const database = fakeDatabase([{ id: 's1', endpoint: 'https://push.example/1' }]);
    const service = new PushService({
      database: database as unknown as DatabaseClient,
      logger,
      vapid,
    });
    service.notifyJobTransition({
      id: 'j1',
      userId: 'u1',
      status: 'cancelled',
      exitCode: null,
      repositoryId: 'r1',
    });
    expect(database.pushSubscription.findMany).not.toHaveBeenCalled();
    expect(sendNotification).not.toHaveBeenCalled();
  });
});
