import type {
  AgentToServerMessage,
  ServerToAgentMessage,
  ServerToClientMessage,
} from '@relaydock/protocol';
import { createMessage } from '@relaydock/protocol';
import type { WebSocket } from '@fastify/websocket';

import type { ServerEnvironment } from '../env.js';
import { AppError } from '../lib/errors.js';

const OPEN_STATE = 1;

interface AgentConnection {
  socket: WebSocket;
  deviceId: string;
  userId: string;
  lastHeartbeatAt: number;
}

interface ClientConnection {
  socket: WebSocket;
  userId: string;
  subscriptions: Map<string, ClientSubscription>;
}

interface ClientSubscription {
  replaying: boolean;
  queuedMessages: ServerToClientMessage[];
}

export class ConnectionHub {
  private readonly agents = new Map<string, AgentConnection>();
  private readonly clients = new Map<WebSocket, ClientConnection>();

  attachAgent(deviceId: string, userId: string, socket: WebSocket): void {
    const existing = this.agents.get(deviceId);
    if (existing !== undefined && existing.socket !== socket) {
      existing.socket.close(4001, 'replaced by a newer connection');
    }
    this.agents.set(deviceId, { socket, deviceId, userId, lastHeartbeatAt: Date.now() });
  }

  detachAgent(deviceId: string, socket: WebSocket): boolean {
    const existing = this.agents.get(deviceId);
    if (existing?.socket !== socket) return false;
    this.agents.delete(deviceId);
    return true;
  }

  heartbeat(deviceId: string, socket: WebSocket): boolean {
    const connection = this.agents.get(deviceId);
    if (connection === undefined || connection.socket !== socket) return false;
    connection.lastHeartbeatAt = Date.now();
    return true;
  }

  isAgentOnline(deviceId: string): boolean {
    return this.agents.get(deviceId)?.socket.readyState === OPEN_STATE;
  }

  sendToAgent(deviceId: string, message: ServerToAgentMessage): boolean {
    const connection = this.agents.get(deviceId);
    if (connection === undefined || !this.send(connection.socket, message)) return false;
    return true;
  }

  closeDevice(deviceId: string, reason: string): void {
    const connection = this.agents.get(deviceId);
    if (connection !== undefined) connection.socket.close(4003, reason.slice(0, 123));
  }

  staleAgents(maximumIdleMs: number, now = Date.now()): AgentConnection[] {
    return [...this.agents.values()].filter(
      (connection) => now - connection.lastHeartbeatAt > maximumIdleMs,
    );
  }

  attachClient(userId: string, socket: WebSocket): void {
    this.clients.set(socket, { socket, userId, subscriptions: new Map() });
  }

  detachClient(socket: WebSocket): void {
    this.clients.delete(socket);
  }

  beginSubscription(socket: WebSocket, jobId: string): void {
    this.clients.get(socket)?.subscriptions.set(jobId, {
      replaying: true,
      queuedMessages: [],
    });
  }

  finishSubscription(socket: WebSocket, jobId: string): void {
    const subscription = this.clients.get(socket)?.subscriptions.get(jobId);
    if (subscription === undefined) return;
    subscription.replaying = false;
    for (const message of subscription.queuedMessages) this.send(socket, message);
    subscription.queuedMessages.length = 0;
  }

  unsubscribe(socket: WebSocket, jobId: string): void {
    this.clients.get(socket)?.subscriptions.delete(jobId);
  }

  broadcastJob(userId: string, jobId: string, message: ServerToClientMessage): void {
    for (const client of this.clients.values()) {
      if (client.userId !== userId) continue;
      const subscription = client.subscriptions.get(jobId);
      if (subscription === undefined) continue;
      if (!subscription.replaying) {
        this.send(client.socket, message);
        continue;
      }
      if (subscription.queuedMessages.length >= 1000) {
        client.socket.close(1013, 'output arrived faster than replay');
        continue;
      }
      subscription.queuedMessages.push(message);
    }
  }

  broadcastDevice(userId: string, message: ServerToClientMessage): void {
    for (const client of this.clients.values()) {
      if (client.userId === userId) this.send(client.socket, message);
    }
  }

  shutdown(): void {
    for (const connection of this.agents.values()) connection.socket.close(1001, 'server shutdown');
    for (const connection of this.clients.values())
      connection.socket.close(1001, 'server shutdown');
    this.agents.clear();
    this.clients.clear();
  }

  private send(socket: WebSocket, message: ServerToAgentMessage | ServerToClientMessage): boolean {
    if (socket.readyState !== OPEN_STATE) return false;
    socket.send(JSON.stringify(message));
    return true;
  }
}

type RepositoryValidationResult = Extract<
  AgentToServerMessage,
  { type: 'repository.validation.result' }
>['payload'];

interface PendingValidation {
  deviceId: string;
  resolve: (result: RepositoryValidationResult) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export class RepositoryValidationBroker {
  private readonly pending = new Map<string, PendingValidation>();

  constructor(
    private readonly connections: ConnectionHub,
    private readonly environment: ServerEnvironment,
  ) {}

  request(deviceId: string, repositoryId: string, absolutePath: string) {
    if (this.pending.has(repositoryId)) {
      throw new AppError(
        409,
        'VALIDATION_IN_PROGRESS',
        'Repository validation is already running.',
      );
    }
    if (!this.connections.isAgentOnline(deviceId)) {
      throw new AppError(409, 'DEVICE_OFFLINE', 'The device must be online to validate a path.');
    }

    return new Promise<RepositoryValidationResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(repositoryId);
        reject(
          new AppError(504, 'VALIDATION_TIMEOUT', 'The agent did not validate the path in time.'),
        );
      }, this.environment.REPOSITORY_VALIDATION_TIMEOUT_MS);
      this.pending.set(repositoryId, { deviceId, resolve, reject, timeout });
      const message: ServerToAgentMessage = createMessage('repository.validate', {
        repositoryId,
        absolutePath,
      });
      if (!this.connections.sendToAgent(deviceId, message)) {
        clearTimeout(timeout);
        this.pending.delete(repositoryId);
        reject(new AppError(409, 'DEVICE_OFFLINE', 'The device disconnected before validation.'));
      }
    });
  }

  settle(deviceId: string, result: RepositoryValidationResult): boolean {
    const pending = this.pending.get(result.repositoryId);
    if (pending === undefined || pending.deviceId !== deviceId) return false;
    clearTimeout(pending.timeout);
    this.pending.delete(result.repositoryId);
    pending.resolve(result);
    return true;
  }

  cancelForDevice(deviceId: string): void {
    for (const [repositoryId, pending] of this.pending) {
      if (pending.deviceId !== deviceId) continue;
      clearTimeout(pending.timeout);
      this.pending.delete(repositoryId);
      pending.reject(
        new AppError(409, 'DEVICE_OFFLINE', 'The device disconnected during validation.'),
      );
    }
  }

  shutdown(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new AppError(503, 'SERVER_SHUTTING_DOWN', 'The server is shutting down.'));
    }
    this.pending.clear();
  }
}
