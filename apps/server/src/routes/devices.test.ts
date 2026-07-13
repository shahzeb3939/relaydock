import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import type { ServerEnvironment } from '../env.js';
import { installErrorHandler } from '../lib/errors.js';
import type { DatabaseClient } from '../prisma.js';
import { AuditService } from '../services/audit.js';
import type { ConnectionHub, RepositoryValidationBroker } from '../services/connections.js';
import { registerDeviceRoutes } from './devices.js';

const deviceId = '33d58cdf-2dd8-4805-a0c2-b08744947c22';
const userId = '4924e444-c6f9-4ddc-ab38-17064d945813';

function device(status: 'online' | 'offline' | 'revoked') {
  return {
    id: deviceId,
    userId,
    name: 'Development laptop',
    platform: 'darwin',
    architecture: 'arm64',
    agentVersion: '0.1.0',
    status,
    lastSeenAt: new Date('2026-07-13T08:00:00.000Z'),
    createdAt: new Date('2026-07-12T08:00:00.000Z'),
    updatedAt: new Date('2026-07-13T08:00:00.000Z'),
  };
}

async function testServer(status: 'online' | 'offline' | 'revoked' | null) {
  const calls: string[] = [];
  const transaction = {
    $queryRaw: vi.fn(async () => {
      calls.push('lock-device');
      return status === null ? [] : [device(status)];
    }),
    device: {
      delete: vi.fn(async () => {
        calls.push('delete-device');
        return device('revoked');
      }),
      update: vi.fn(async () => {
        calls.push('revoke-device');
        return device('revoked');
      }),
    },
    job: {
      deleteMany: vi.fn(async () => {
        calls.push('delete-jobs');
        return { count: 2 };
      }),
      updateMany: vi.fn(async () => {
        calls.push('disconnect-jobs');
        return { count: 0 };
      }),
    },
    repository: {
      deleteMany: vi.fn(async () => {
        calls.push('delete-repositories');
        return { count: 1 };
      }),
    },
    deviceCredential: {
      updateMany: vi.fn(async () => {
        calls.push('revoke-credentials');
        return { count: 1 };
      }),
    },
    auditEvent: {
      create: vi.fn(async (args: unknown) => {
        calls.push('create-audit');
        return args;
      }),
    },
  };
  const database = {
    device: {
      findFirst: vi.fn(async () => {
        calls.push('find-device-before-revoke');
        return status === null ? null : device(status);
      }),
    },
    job: {
      findMany: vi.fn(async () => {
        calls.push('find-running-jobs');
        return [];
      }),
    },
    $transaction: vi.fn(async (callback: (client: typeof transaction) => Promise<unknown>) => {
      calls.push('transaction-start');
      const result = await callback(transaction);
      calls.push('transaction-commit');
      return result;
    }),
  } as unknown as DatabaseClient;
  const connections = {
    closeDevice: vi.fn(async () => undefined),
    sendToAgent: vi.fn(async () => true),
    broadcastDevice: vi.fn(async () => undefined),
    broadcastJob: vi.fn(async () => undefined),
  } as unknown as ConnectionHub;
  const validations = {
    cancelForDevice: vi.fn(async () => undefined),
  } as unknown as RepositoryValidationBroker;
  const requireCsrf = vi.fn(async () => undefined);
  const app = Fastify({ logger: false });
  app.decorateRequest('auth', null);
  installErrorHandler(app);
  registerDeviceRoutes(app, {
    database,
    environment: {} as ServerEnvironment,
    audit: new AuditService(database),
    connections,
    validations,
    requireAuth: async (request) => {
      request.auth = {
        sessionId: '751cb1c4-b03a-49b5-8a1f-fddc73aa5d83',
        csrfTokenHash: 'csrf-hash',
        user: {
          id: userId,
          email: 'owner@example.com',
          createdAt: new Date('2026-07-12T07:00:00.000Z'),
        },
      };
    },
    requireCsrf,
  });

  return { app, calls, connections, database, requireCsrf, transaction, validations };
}

describe('permanent device deletion', () => {
  it('deletes all device-owned operational data only after revocation', async () => {
    const context = await testServer('revoked');

    const response = await context.app.inject({
      method: 'DELETE',
      url: `/api/devices/${deviceId}/permanent`,
    });

    expect(response.statusCode).toBe(204);
    expect(context.calls).toEqual([
      'transaction-start',
      'lock-device',
      'delete-jobs',
      'delete-repositories',
      'delete-device',
      'create-audit',
      'transaction-commit',
    ]);
    expect(context.transaction.$queryRaw).toHaveBeenCalledOnce();
    expect(context.transaction.auditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'device.deleted',
        userId,
        metadata: { deviceId, deviceName: 'Development laptop' },
      }),
    });
    expect(context.transaction.auditEvent.create).toHaveBeenCalledWith({
      data: expect.not.objectContaining({ deviceId }),
    });
    expect(context.connections.closeDevice).toHaveBeenCalledWith(deviceId, 'device deleted');
    expect(context.validations.cancelForDevice).toHaveBeenCalledWith(deviceId);
    expect(context.requireCsrf).toHaveBeenCalledOnce();
    await context.app.close();
  });

  it.each(['online', 'offline'] as const)(
    'rejects a %s device without deleting any data',
    async (status) => {
      const context = await testServer(status);

      const response = await context.app.inject({
        method: 'DELETE',
        url: `/api/devices/${deviceId}/permanent`,
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: 'DEVICE_NOT_REVOKED' } });
      expect(context.calls).toEqual(['transaction-start', 'lock-device']);
      expect(context.connections.closeDevice).not.toHaveBeenCalled();
      await context.app.close();
    },
  );

  it('does not reveal whether a missing device belongs to another user', async () => {
    const context = await testServer(null);

    const response = await context.app.inject({
      method: 'DELETE',
      url: `/api/devices/${deviceId}/permanent`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'DEVICE_NOT_FOUND' } });
    expect(context.calls).toEqual(['transaction-start', 'lock-device']);
    await context.app.close();
  });

  it('commits revocation and its audit event before notifying other clients', async () => {
    const context = await testServer('offline');
    vi.mocked(context.connections.broadcastDevice).mockImplementation(async () => {
      context.calls.push('broadcast-revoked');
    });
    vi.mocked(context.connections.closeDevice).mockImplementation(async () => {
      context.calls.push('close-device');
    });

    const response = await context.app.inject({
      method: 'DELETE',
      url: `/api/devices/${deviceId}`,
    });

    expect(response.statusCode).toBe(204);
    expect(context.calls).toEqual([
      'find-device-before-revoke',
      'find-running-jobs',
      'transaction-start',
      'revoke-device',
      'revoke-credentials',
      'disconnect-jobs',
      'create-audit',
      'transaction-commit',
      'broadcast-revoked',
      'close-device',
    ]);
    expect(context.transaction.auditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'device.revoked',
        deviceId,
        metadata: { deviceId, deviceName: 'Development laptop' },
      }),
    });
    await context.app.close();
  });
});
