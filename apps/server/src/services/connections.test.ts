import type { WebSocket } from '@fastify/websocket';
import { createMessage } from '@relaydock/protocol';
import type { ServerToAgentMessage, ServerToClientMessage } from '@relaydock/protocol';
import { describe, expect, it, vi } from 'vitest';

import { ConnectionHub, type RepositoryValidationResult } from './connections.js';

function socketDouble() {
  const send = vi.fn();
  const close = vi.fn();
  const socket = { readyState: 1, send, close } as unknown as WebSocket;
  return { socket, send, close };
}

describe('client output subscription replay', () => {
  it('queues live output until replay has been sent, preserving arrival order', async () => {
    const hub = new ConnectionHub();
    const { socket, send } = socketDouble();
    const userId = '6dfd79d4-cf11-43b9-b6ff-180e1a163961';
    const jobId = '7b47872c-ed62-44ac-93d5-103fd62a5aa7';
    hub.attachClient(userId, socket);
    hub.beginSubscription(socket, jobId);

    const first: ServerToClientMessage = createMessage('job.output', {
      jobId,
      sequence: 11,
      stream: 'stdout',
      data: 'first',
    });
    const second: ServerToClientMessage = createMessage('job.output', {
      jobId,
      sequence: 12,
      stream: 'stdout',
      data: 'second',
    });
    await hub.broadcastJob(userId, jobId, first);
    await hub.broadcastJob(userId, jobId, second);
    expect(send).not.toHaveBeenCalled();

    hub.finishSubscription(socket, jobId);
    expect(
      send.mock.calls.map(([message]) => JSON.parse(String(message)).payload.sequence),
    ).toEqual([11, 12]);
  });
});

describe('client backpressure safety valve', () => {
  const userId = '6dfd79d4-cf11-43b9-b6ff-180e1a163961';
  const jobId = '7b47872c-ed62-44ac-93d5-103fd62a5aa7';
  const liveChunk = () =>
    createMessage('job.output', { jobId, sequence: 1, stream: 'stdout' as const, data: 'x' });

  function liveViewer(bufferedAmount: number) {
    const send = vi.fn();
    const close = vi.fn();
    const socket = { readyState: 1, send, close, bufferedAmount } as unknown as WebSocket;
    const hub = new ConnectionHub();
    hub.attachClient(userId, socket);
    hub.beginSubscription(socket, jobId);
    hub.finishSubscription(socket, jobId);
    return { hub, send, close };
  }

  it('closes a live viewer whose send buffer has ballooned past the cap', async () => {
    const { hub, send, close } = liveViewer(16 * 1024 * 1024);
    await hub.broadcastJob(userId, jobId, liveChunk());
    expect(send).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledWith(1013, expect.stringContaining('behind'));
  });

  it('delivers to a viewer whose buffer is within bounds', async () => {
    const { hub, send, close } = liveViewer(1024);
    await hub.broadcastJob(userId, jobId, liveChunk());
    expect(send).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
  });
});

describe('local connection behavior', () => {
  it('attaches, sends to, heartbeats, and conditionally detaches an agent', async () => {
    const hub = new ConnectionHub({ instanceId: 'local-test-instance' });
    const deviceId = '751cb1c4-b03a-49b5-8a1f-fddc73aa5d83';
    const userId = '77dc36c7-6119-49c1-9cc1-22099d773412';
    const { socket, send } = socketDouble();
    const otherSocket = socketDouble().socket;
    const message: ServerToAgentMessage = createMessage('job.cancel', {
      jobId: '5a4072dd-60b8-4ea1-b210-12651fc8724d',
    });

    expect(hub.distributed).toBe(false);
    await hub.start();
    await hub.attachAgent(deviceId, userId, socket);
    expect(await hub.isAgentOnline(deviceId)).toBe(true);
    expect(await hub.sendToAgent(deviceId, message)).toBe(true);
    expect(JSON.parse(String(send.mock.calls[0]?.[0]))).toMatchObject({ type: 'job.cancel' });
    expect(await hub.heartbeat(deviceId, socket)).toBe(true);
    expect(await hub.detachAgent(deviceId, otherSocket)).toBe(false);
    expect(await hub.detachAgent(deviceId, socket)).toBe(true);
    expect(await hub.isAgentOnline(deviceId)).toBe(false);
  });

  it('fences an older local socket when a newer agent connection replaces it', async () => {
    const hub = new ConnectionHub();
    const deviceId = 'a0405e6b-6b72-45e8-b84c-a80fcdb63a9a';
    const userId = '20ba8b75-bb37-40b5-9ae7-729a9aa34e36';
    const first = socketDouble();
    const second = socketDouble();

    await hub.attachAgent(deviceId, userId, first.socket);
    await hub.attachAgent(deviceId, userId, second.socket);

    expect(first.close).toHaveBeenCalledWith(4001, 'replaced by a newer connection');
    expect(await hub.detachAgent(deviceId, first.socket)).toBe(false);
    expect(await hub.isAgentOnline(deviceId)).toBe(true);
    expect(await hub.detachAgent(deviceId, second.socket)).toBe(true);
  });

  it('fans device status out only to sockets owned by the target user', async () => {
    const hub = new ConnectionHub();
    const target = socketDouble();
    const other = socketDouble();
    const userId = 'b12c6c96-af94-4ed9-bc98-94beab015a74';
    hub.attachClient(userId, target.socket);
    hub.attachClient('2e5feea8-e6ad-43aa-a8b8-165435bfc3fd', other.socket);

    await hub.broadcastDevice(
      userId,
      createMessage('device.status', {
        deviceId: '33d58cdf-2dd8-4805-a0c2-b08744947c22',
        status: 'online',
        lastSeenAt: '2026-07-13T12:00:00.000Z',
      }),
    );

    expect(target.send).toHaveBeenCalledOnce();
    expect(other.send).not.toHaveBeenCalled();
  });
});

describe('validation event listeners', () => {
  it('delivers local results and cancellation and supports unsubscribe', async () => {
    const hub = new ConnectionHub();
    const deviceId = '4924e444-c6f9-4ddc-ab38-17064d945813';
    const result: RepositoryValidationResult = {
      repositoryId: 'c456bdb0-2214-41b1-8771-59d3cc76a878',
      valid: true,
      canonicalPath: '/tmp/project',
      repositoryRoot: '/tmp/project',
      isGitRepository: true,
      branch: 'main',
    };
    const resultListener = vi.fn(() => true);
    const cancelListener = vi.fn();
    const unsubscribeResult = hub.onValidationResult(resultListener);
    const unsubscribeCancel = hub.onValidationCancel(cancelListener);

    expect(await hub.publishValidationResult(deviceId, result)).toBe(true);
    await hub.publishValidationCancel(deviceId);
    expect(resultListener).toHaveBeenCalledWith(deviceId, result);
    expect(cancelListener).toHaveBeenCalledWith(deviceId);

    unsubscribeResult();
    unsubscribeCancel();
    await hub.publishValidationResult(deviceId, result);
    await hub.publishValidationCancel(deviceId);
    expect(resultListener).toHaveBeenCalledOnce();
    expect(cancelListener).toHaveBeenCalledOnce();
  });
});

const describeRedis = process.env.TEST_REDIS_URL === undefined ? describe.skip : describe;

describeRedis('distributed Redis relay', () => {
  it('routes agent commands and client events across instances and fences replacements', async () => {
    const namespace = `relaydock-test-${crypto.randomUUID()}`;
    const options = {
      redisUrl: process.env.TEST_REDIS_URL,
      namespace,
      presenceTtlMs: 10_000,
      requestTimeoutMs: 3_000,
    };
    const agentInstance = new ConnectionHub({ ...options, instanceId: 'agent-instance' });
    const clientInstance = new ConnectionHub({ ...options, instanceId: 'client-instance' });
    const deviceId = '3172b1a7-2314-4dbd-834a-6ce8d562679f';
    const userId = '1d4a18ea-bb52-4483-b97f-1085bdcbac58';
    const jobId = '9757a578-479f-4c84-9cf7-abf453df2094';
    const firstAgent = socketDouble();
    const replacementAgent = socketDouble();
    const client = socketDouble();

    try {
      await Promise.all([agentInstance.start(), clientInstance.start()]);
      await agentInstance.attachAgent(deviceId, userId, firstAgent.socket);
      expect(await clientInstance.isAgentOnline(deviceId)).toBe(true);

      const cancel: ServerToAgentMessage = createMessage('job.cancel', { jobId });
      expect(await clientInstance.sendToAgent(deviceId, cancel)).toBe(true);
      expect(JSON.parse(String(firstAgent.send.mock.calls[0]?.[0]))).toMatchObject({
        type: 'job.cancel',
      });

      clientInstance.attachClient(userId, client.socket);
      await agentInstance.broadcastDevice(
        userId,
        createMessage('device.status', {
          deviceId,
          status: 'online',
          lastSeenAt: '2026-07-13T12:00:00.000Z',
        }),
      );
      await vi.waitFor(() => expect(client.send).toHaveBeenCalledOnce());

      await clientInstance.attachAgent(deviceId, userId, replacementAgent.socket);
      await vi.waitFor(() =>
        expect(firstAgent.close).toHaveBeenCalledWith(4001, 'replaced by a newer connection'),
      );
      expect(await agentInstance.detachAgent(deviceId, firstAgent.socket)).toBe(false);
      expect(await agentInstance.sendToAgent(deviceId, cancel)).toBe(true);
      expect(replacementAgent.send).toHaveBeenCalledOnce();
    } finally {
      await Promise.all([agentInstance.shutdown(), clientInstance.shutdown()]);
    }
  });
});
