import type { WebSocket } from '@fastify/websocket';
import { createMessage } from '@relaydock/protocol';
import type { ServerToClientMessage } from '@relaydock/protocol';
import { describe, expect, it, vi } from 'vitest';

import { ConnectionHub } from './connections.js';

function socketDouble() {
  const send = vi.fn();
  const close = vi.fn();
  const socket = { readyState: 1, send, close } as unknown as WebSocket;
  return { socket, send };
}

describe('client output subscription replay', () => {
  it('queues live output until replay has been sent, preserving arrival order', () => {
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
    hub.broadcastJob(userId, jobId, first);
    hub.broadcastJob(userId, jobId, second);
    expect(send).not.toHaveBeenCalled();

    hub.finishSubscription(socket, jobId);
    expect(
      send.mock.calls.map(([message]) => JSON.parse(String(message)).payload.sequence),
    ).toEqual([11, 12]);
  });
});
