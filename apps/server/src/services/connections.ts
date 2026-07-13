import { createRequire } from 'node:module';

import type {
  AgentToServerMessage,
  ServerToAgentMessage,
  ServerToClientMessage,
} from '@relaydock/protocol';
import {
  createMessage,
  serverToAgentMessageSchema,
  serverToClientMessageSchema,
} from '@relaydock/protocol';
import type { WebSocket } from '@fastify/websocket';

import type { ServerEnvironment } from '../env.js';
import { AppError } from '../lib/errors.js';

const OPEN_STATE = 1;
const RELAY_VERSION = 1;
const DEFAULT_NAMESPACE = 'relaydock';
const DEFAULT_PRESENCE_TTL_MS = 45_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 2_000;
const CLOSE_REASON_MAX_BYTES = 123;

const claimPresenceScript = `
local previous = redis.call('GET', KEYS[1])
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
return previous
`;

const touchPresenceScript = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return 1
end
return 0
`;

const releasePresenceScript = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('DEL', KEYS[1])
  return 1
end
return 0
`;

interface RedisClient {
  readonly status: string;
  connect(): Promise<void>;
  duplicate(): RedisClient;
  subscribe(channel: string): Promise<unknown>;
  unsubscribe(channel: string): Promise<unknown>;
  publish(channel: string, message: string): Promise<number>;
  get(key: string): Promise<string | null>;
  eval(
    script: string,
    numberOfKeys: number,
    ...arguments_: Array<string | number>
  ): Promise<unknown>;
  quit(): Promise<unknown>;
  disconnect(reconnect?: boolean): void;
  on(event: 'message', listener: (channel: string, message: string) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  off(event: 'message', listener: (channel: string, message: string) => void): this;
  off(event: 'error', listener: (error: Error) => void): this;
}

type RedisConstructor = new (url: string, options: Record<string, unknown>) => RedisClient;

interface AgentOwner {
  instanceId: string;
  connectionId: string;
  userId: string;
}

interface AgentConnection extends AgentOwner {
  socket: WebSocket;
  deviceId: string;
  lastHeartbeatAt: number;
  presenceValue: string;
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

interface RelayEnvelopeBase {
  relayVersion: typeof RELAY_VERSION;
  id: string;
  sourceInstanceId: string;
  targetInstanceId: string | null;
  createdAt: number;
  expiresAt: number;
}

interface AgentSendEnvelope extends RelayEnvelopeBase {
  kind: 'agent.send';
  correlationId: string;
  deviceId: string;
  expectedConnectionId: string;
  message: ServerToAgentMessage;
}

interface AgentCloseEnvelope extends RelayEnvelopeBase {
  kind: 'agent.close';
  deviceId: string;
  expectedConnectionId: string;
  code: number;
  reason: string;
}

interface AckEnvelope extends RelayEnvelopeBase {
  kind: 'relay.ack';
  correlationId: string;
  sent: boolean;
}

interface JobBroadcastEnvelope extends RelayEnvelopeBase {
  kind: 'client.job';
  userId: string;
  jobId: string;
  message: ServerToClientMessage;
}

interface DeviceBroadcastEnvelope extends RelayEnvelopeBase {
  kind: 'client.device';
  userId: string;
  message: ServerToClientMessage;
}

interface ValidationResultEnvelope extends RelayEnvelopeBase {
  kind: 'validation.result';
  deviceId: string;
  result: RepositoryValidationResult;
}

interface ValidationCancelEnvelope extends RelayEnvelopeBase {
  kind: 'validation.cancel';
  deviceId: string;
}

type RelayEnvelope =
  | AgentSendEnvelope
  | AgentCloseEnvelope
  | AckEnvelope
  | JobBroadcastEnvelope
  | DeviceBroadcastEnvelope
  | ValidationResultEnvelope
  | ValidationCancelEnvelope;

interface PendingAck {
  resolve: (sent: boolean) => void;
  timeout: NodeJS.Timeout;
}

export interface ConnectionHubOptions {
  redisUrl?: string | undefined;
  namespace?: string | undefined;
  presenceTtlMs?: number | undefined;
  requestTimeoutMs?: number | undefined;
  instanceId?: string | undefined;
}

export type RepositoryValidationResult = Extract<
  AgentToServerMessage,
  { type: 'repository.validation.result' }
>['payload'];

export type ValidationResultListener = (
  deviceId: string,
  result: RepositoryValidationResult,
) => boolean | void;
export type ValidationCancelListener = (deviceId: string) => void;

function loadRedisConstructor(): RedisConstructor {
  const require = createRequire(import.meta.url);
  let loaded: unknown;
  try {
    loaded = require('ioredis') as unknown;
  } catch (error) {
    throw new Error('Redis routing requires the optional ioredis package.', { cause: error });
  }
  if (typeof loaded === 'function') return loaded as RedisConstructor;
  if (
    typeof loaded === 'object' &&
    loaded !== null &&
    'default' in loaded &&
    typeof loaded.default === 'function'
  ) {
    return loaded.default as RedisConstructor;
  }
  throw new Error('The installed ioredis package does not expose a Redis constructor.');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseAgentOwner(value: string | null): AgentOwner | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      !isRecord(parsed) ||
      typeof parsed.instanceId !== 'string' ||
      typeof parsed.connectionId !== 'string' ||
      typeof parsed.userId !== 'string'
    ) {
      return null;
    }
    return {
      instanceId: parsed.instanceId,
      connectionId: parsed.connectionId,
      userId: parsed.userId,
    };
  } catch {
    return null;
  }
}

function isValidationResult(value: unknown): value is RepositoryValidationResult {
  return (
    isRecord(value) &&
    typeof value.repositoryId === 'string' &&
    typeof value.valid === 'boolean' &&
    typeof value.isGitRepository === 'boolean'
  );
}

function parseRelayEnvelope(raw: string): RelayEnvelope | null {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (
    !isRecord(value) ||
    value.relayVersion !== RELAY_VERSION ||
    typeof value.id !== 'string' ||
    typeof value.kind !== 'string' ||
    typeof value.sourceInstanceId !== 'string' ||
    !(typeof value.targetInstanceId === 'string' || value.targetInstanceId === null) ||
    typeof value.createdAt !== 'number' ||
    typeof value.expiresAt !== 'number'
  ) {
    return null;
  }

  const base = value as unknown as RelayEnvelopeBase & Record<string, unknown>;
  switch (value.kind) {
    case 'agent.send': {
      const parsedMessage = serverToAgentMessageSchema.safeParse(value.message);
      if (
        typeof value.correlationId !== 'string' ||
        typeof value.deviceId !== 'string' ||
        typeof value.expectedConnectionId !== 'string' ||
        !parsedMessage.success
      ) {
        return null;
      }
      return {
        ...base,
        kind: 'agent.send',
        correlationId: value.correlationId,
        deviceId: value.deviceId,
        expectedConnectionId: value.expectedConnectionId,
        message: parsedMessage.data,
      };
    }
    case 'agent.close':
      if (
        typeof value.deviceId !== 'string' ||
        typeof value.expectedConnectionId !== 'string' ||
        typeof value.code !== 'number' ||
        typeof value.reason !== 'string'
      ) {
        return null;
      }
      return {
        ...base,
        kind: 'agent.close',
        deviceId: value.deviceId,
        expectedConnectionId: value.expectedConnectionId,
        code: value.code,
        reason: value.reason,
      };
    case 'relay.ack':
      if (typeof value.correlationId !== 'string' || typeof value.sent !== 'boolean') return null;
      return {
        ...base,
        kind: 'relay.ack',
        correlationId: value.correlationId,
        sent: value.sent,
      };
    case 'client.job': {
      const parsedMessage = serverToClientMessageSchema.safeParse(value.message);
      if (
        typeof value.userId !== 'string' ||
        typeof value.jobId !== 'string' ||
        !parsedMessage.success
      ) {
        return null;
      }
      return {
        ...base,
        kind: 'client.job',
        userId: value.userId,
        jobId: value.jobId,
        message: parsedMessage.data,
      };
    }
    case 'client.device': {
      const parsedMessage = serverToClientMessageSchema.safeParse(value.message);
      if (typeof value.userId !== 'string' || !parsedMessage.success) return null;
      return {
        ...base,
        kind: 'client.device',
        userId: value.userId,
        message: parsedMessage.data,
      };
    }
    case 'validation.result':
      if (typeof value.deviceId !== 'string' || !isValidationResult(value.result)) return null;
      return {
        ...base,
        kind: 'validation.result',
        deviceId: value.deviceId,
        result: value.result,
      };
    case 'validation.cancel':
      if (typeof value.deviceId !== 'string') return null;
      return { ...base, kind: 'validation.cancel', deviceId: value.deviceId };
    default:
      return null;
  }
}

export class ConnectionHub {
  readonly instanceId: string;

  private readonly agents = new Map<string, AgentConnection>();
  private readonly clients = new Map<WebSocket, ClientConnection>();
  private readonly validationResultListeners = new Set<ValidationResultListener>();
  private readonly validationCancelListeners = new Set<ValidationCancelListener>();
  private readonly pendingAcks = new Map<string, PendingAck>();
  private readonly redisUrl: string | undefined;
  private readonly namespace: string;
  private readonly presenceTtlMs: number;
  private readonly requestTimeoutMs: number;
  private readonly relayChannel: string;
  private redis: RedisClient | undefined;
  private subscriber: RedisClient | undefined;
  private startPromise: Promise<void> | undefined;
  private shutdownPromise: Promise<void> | undefined;
  private shuttingDown = false;

  constructor(options: ConnectionHubOptions = {}) {
    const redisUrl = options.redisUrl?.trim();
    this.redisUrl = redisUrl === undefined || redisUrl === '' ? undefined : redisUrl;
    this.namespace = options.namespace?.trim() || DEFAULT_NAMESPACE;
    this.presenceTtlMs = Math.max(1_000, options.presenceTtlMs ?? DEFAULT_PRESENCE_TTL_MS);
    this.requestTimeoutMs = Math.max(100, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
    this.instanceId = options.instanceId?.trim() || crypto.randomUUID();
    this.relayChannel = `${this.namespace}:connections:v1`;
  }

  get distributed(): boolean {
    return this.redisUrl !== undefined;
  }

  async start(): Promise<void> {
    if (!this.distributed || this.shuttingDown) return;
    if (this.startPromise !== undefined) return this.startPromise;
    const starting = this.connectRedis();
    this.startPromise = starting;
    try {
      await starting;
    } catch (error) {
      if (this.startPromise === starting) this.startPromise = undefined;
      throw error;
    }
  }

  async attachAgent(deviceId: string, userId: string, socket: WebSocket): Promise<void> {
    const existing = this.agents.get(deviceId);
    const connectionId = crypto.randomUUID();
    const owner: AgentOwner = { instanceId: this.instanceId, connectionId, userId };
    const presenceValue = JSON.stringify(owner);
    let previousOwner: AgentOwner | null = null;

    if (this.distributed) {
      await this.start();
      const previous = await this.redis?.eval(
        claimPresenceScript,
        1,
        this.presenceKey(deviceId),
        presenceValue,
        this.presenceTtlMs,
      );
      previousOwner = parseAgentOwner(typeof previous === 'string' ? previous : null);
    }

    const connection: AgentConnection = {
      ...owner,
      socket,
      deviceId,
      lastHeartbeatAt: Date.now(),
      presenceValue,
    };
    this.agents.set(deviceId, connection);
    if (existing !== undefined && existing.socket !== socket) {
      existing.socket.close(4001, 'replaced by a newer connection');
    }

    if (
      previousOwner !== null &&
      previousOwner.connectionId !== connectionId &&
      previousOwner.instanceId !== this.instanceId
    ) {
      await this.publishBestEffort({
        ...this.envelopeBase('agent.close', previousOwner.instanceId, 10_000),
        kind: 'agent.close',
        deviceId,
        expectedConnectionId: previousOwner.connectionId,
        code: 4001,
        reason: 'replaced by a newer connection',
      });
    }
  }

  async detachAgent(deviceId: string, socket: WebSocket): Promise<boolean> {
    const existing = this.agents.get(deviceId);
    if (existing === undefined || existing.socket !== socket) return false;
    if (this.distributed) {
      try {
        await this.start();
        const released = await this.redis?.eval(
          releasePresenceScript,
          1,
          this.presenceKey(deviceId),
          existing.presenceValue,
        );
        if (Number(released) !== 1) {
          this.agents.delete(deviceId);
          return false;
        }
      } catch {
        return false;
      }
    }
    this.agents.delete(deviceId);
    return true;
  }

  async heartbeat(deviceId: string, socket: WebSocket): Promise<boolean> {
    const connection = this.agents.get(deviceId);
    if (connection === undefined || connection.socket !== socket) return false;
    if (this.distributed && !(await this.touchConnection(connection))) {
      this.agents.delete(deviceId);
      connection.socket.close(4001, 'replaced by a newer connection');
      return false;
    }
    connection.lastHeartbeatAt = Date.now();
    return true;
  }

  async isAgentOnline(deviceId: string): Promise<boolean> {
    if (!this.distributed) return this.isLocalAgentOnline(deviceId);
    try {
      await this.start();
      return parseAgentOwner((await this.redis?.get(this.presenceKey(deviceId))) ?? null) !== null;
    } catch {
      return false;
    }
  }

  async sendToAgent(deviceId: string, message: ServerToAgentMessage): Promise<boolean> {
    if (!this.distributed) return this.sendToLocalAgent(deviceId, undefined, message);
    try {
      await this.start();
      let owner = await this.getAgentOwner(deviceId);
      if (owner === null) return false;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const sent =
          owner.instanceId === this.instanceId
            ? await this.sendToOwnedLocalAgent(deviceId, owner.connectionId, message)
            : await this.sendToRemoteAgent(deviceId, owner, message);
        if (sent) return true;
        const nextOwner = await this.getAgentOwner(deviceId);
        if (
          nextOwner === null ||
          (nextOwner.instanceId === owner.instanceId &&
            nextOwner.connectionId === owner.connectionId)
        ) {
          return false;
        }
        owner = nextOwner;
      }
      return false;
    } catch {
      return false;
    }
  }

  async closeDevice(deviceId: string, reason: string): Promise<void> {
    const safeReason = reason.slice(0, CLOSE_REASON_MAX_BYTES);
    if (!this.distributed) {
      this.agents.get(deviceId)?.socket.close(4003, safeReason);
      return;
    }
    try {
      await this.start();
      const owner = await this.getAgentOwner(deviceId);
      if (owner === null) return;
      if (owner.instanceId === this.instanceId) {
        const local = this.agents.get(deviceId);
        if (local?.connectionId === owner.connectionId) local.socket.close(4003, safeReason);
        return;
      }
      await this.publishBestEffort({
        ...this.envelopeBase('agent.close', owner.instanceId, 10_000),
        kind: 'agent.close',
        deviceId,
        expectedConnectionId: owner.connectionId,
        code: 4003,
        reason: safeReason,
      });
    } catch {
      // Revocation is authoritative in PostgreSQL; closing a live socket is best effort.
    }
  }

  staleAgents(maximumIdleMs: number, now = Date.now()): AgentConnection[] {
    return [...this.agents.values()].filter(
      (connection) => now - connection.lastHeartbeatAt > maximumIdleMs,
    );
  }

  attachClient(userId: string, socket: WebSocket): void {
    this.clients.set(socket, { socket, userId, subscriptions: new Map() });
    if (this.distributed) void this.start().catch(() => undefined);
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

  async broadcastJob(userId: string, jobId: string, message: ServerToClientMessage): Promise<void> {
    this.broadcastJobLocally(userId, jobId, message);
    if (!this.distributed) return;
    await this.publishBestEffort({
      ...this.envelopeBase('client.job', null, 30_000),
      kind: 'client.job',
      userId,
      jobId,
      message,
    });
  }

  async broadcastDevice(userId: string, message: ServerToClientMessage): Promise<void> {
    this.broadcastDeviceLocally(userId, message);
    if (!this.distributed) return;
    await this.publishBestEffort({
      ...this.envelopeBase('client.device', null, 30_000),
      kind: 'client.device',
      userId,
      message,
    });
  }

  async publishValidationResult(
    deviceId: string,
    result: RepositoryValidationResult,
  ): Promise<boolean> {
    const handledLocally = this.emitValidationResult(deviceId, result);
    if (!this.distributed) return handledLocally;
    const published = await this.publishBestEffort({
      ...this.envelopeBase('validation.result', null, 30_000),
      kind: 'validation.result',
      deviceId,
      result,
    });
    return handledLocally || published;
  }

  async publishValidationCancel(deviceId: string): Promise<void> {
    this.emitValidationCancel(deviceId);
    if (!this.distributed) return;
    await this.publishBestEffort({
      ...this.envelopeBase('validation.cancel', null, 30_000),
      kind: 'validation.cancel',
      deviceId,
    });
  }

  onValidationResult(listener: ValidationResultListener): () => void {
    this.validationResultListeners.add(listener);
    return () => this.validationResultListeners.delete(listener);
  }

  onValidationCancel(listener: ValidationCancelListener): () => void {
    this.validationCancelListeners.add(listener);
    return () => this.validationCancelListeners.delete(listener);
  }

  shutdown(): Promise<void> {
    this.shutdownPromise ??= this.performShutdown();
    return this.shutdownPromise;
  }

  private async connectRedis(): Promise<void> {
    if (this.redisUrl === undefined) return;
    const Redis = loadRedisConstructor();
    const redis = new Redis(this.redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      commandTimeout: Math.max(this.requestTimeoutMs, 1_000),
      enableOfflineQueue: false,
    });
    const subscriber = redis.duplicate();
    redis.on('error', this.redisErrorHandler);
    subscriber.on('error', this.redisErrorHandler);
    subscriber.on('message', this.redisMessageHandler);
    try {
      await Promise.all([redis.connect(), subscriber.connect()]);
      await subscriber.subscribe(this.relayChannel);
      this.redis = redis;
      this.subscriber = subscriber;
    } catch (error) {
      subscriber.off('message', this.redisMessageHandler);
      redis.disconnect(false);
      subscriber.disconnect(false);
      throw error;
    }
  }

  private readonly redisErrorHandler = (_error: Error): void => {
    // Callers fail closed for commands and treat fanout as best effort.
  };

  private readonly redisMessageHandler = (channel: string, raw: string): void => {
    if (channel !== this.relayChannel || this.shuttingDown) return;
    void this.handleRelayMessage(raw).catch(() => undefined);
  };

  private async handleRelayMessage(raw: string): Promise<void> {
    const envelope = parseRelayEnvelope(raw);
    if (envelope === null || envelope.expiresAt <= Date.now()) return;
    if (envelope.targetInstanceId !== null && envelope.targetInstanceId !== this.instanceId) {
      return;
    }
    if (envelope.sourceInstanceId === this.instanceId && envelope.kind !== 'relay.ack') return;

    switch (envelope.kind) {
      case 'agent.send': {
        const sent = await this.sendToOwnedLocalAgent(
          envelope.deviceId,
          envelope.expectedConnectionId,
          envelope.message,
        );
        await this.publishBestEffort({
          ...this.envelopeBase('relay.ack', envelope.sourceInstanceId, 5_000),
          kind: 'relay.ack',
          correlationId: envelope.correlationId,
          sent,
        });
        return;
      }
      case 'agent.close': {
        const connection = this.agents.get(envelope.deviceId);
        if (connection?.connectionId === envelope.expectedConnectionId) {
          connection.socket.close(envelope.code, envelope.reason.slice(0, CLOSE_REASON_MAX_BYTES));
        }
        return;
      }
      case 'relay.ack': {
        const pending = this.pendingAcks.get(envelope.correlationId);
        if (pending === undefined) return;
        clearTimeout(pending.timeout);
        this.pendingAcks.delete(envelope.correlationId);
        pending.resolve(envelope.sent);
        return;
      }
      case 'client.job':
        this.broadcastJobLocally(envelope.userId, envelope.jobId, envelope.message);
        return;
      case 'client.device':
        this.broadcastDeviceLocally(envelope.userId, envelope.message);
        return;
      case 'validation.result':
        this.emitValidationResult(envelope.deviceId, envelope.result);
        return;
      case 'validation.cancel':
        this.emitValidationCancel(envelope.deviceId);
        return;
    }
    envelope satisfies never;
  }

  private async sendToRemoteAgent(
    deviceId: string,
    owner: AgentOwner,
    message: ServerToAgentMessage,
  ): Promise<boolean> {
    const correlationId = crypto.randomUUID();
    let resolveAck: (sent: boolean) => void = () => undefined;
    const result = new Promise<boolean>((resolve) => {
      resolveAck = resolve;
    });
    const timeout = setTimeout(() => {
      this.pendingAcks.delete(correlationId);
      resolveAck(false);
    }, this.requestTimeoutMs);
    timeout.unref();
    this.pendingAcks.set(correlationId, { resolve: resolveAck, timeout });

    const published = await this.publishBestEffort({
      ...this.envelopeBase('agent.send', owner.instanceId, this.requestTimeoutMs),
      kind: 'agent.send',
      correlationId,
      deviceId,
      expectedConnectionId: owner.connectionId,
      message,
    });
    if (!published) {
      clearTimeout(timeout);
      this.pendingAcks.delete(correlationId);
      resolveAck(false);
    }
    return result;
  }

  private async sendToOwnedLocalAgent(
    deviceId: string,
    expectedConnectionId: string,
    message: ServerToAgentMessage,
  ): Promise<boolean> {
    const connection = this.agents.get(deviceId);
    if (connection?.connectionId !== expectedConnectionId) return false;
    if (this.distributed && !(await this.touchConnection(connection))) {
      this.agents.delete(deviceId);
      connection.socket.close(4001, 'replaced by a newer connection');
      return false;
    }
    return this.send(connection.socket, message);
  }

  private sendToLocalAgent(
    deviceId: string,
    expectedConnectionId: string | undefined,
    message: ServerToAgentMessage,
  ): boolean {
    const connection = this.agents.get(deviceId);
    if (
      connection === undefined ||
      (expectedConnectionId !== undefined && connection.connectionId !== expectedConnectionId)
    ) {
      return false;
    }
    return this.send(connection.socket, message);
  }

  private isLocalAgentOnline(deviceId: string): boolean {
    return this.agents.get(deviceId)?.socket.readyState === OPEN_STATE;
  }

  private async touchConnection(connection: AgentConnection): Promise<boolean> {
    try {
      await this.start();
      const touched = await this.redis?.eval(
        touchPresenceScript,
        1,
        this.presenceKey(connection.deviceId),
        connection.presenceValue,
        this.presenceTtlMs,
      );
      return Number(touched) === 1;
    } catch {
      return false;
    }
  }

  private async getAgentOwner(deviceId: string): Promise<AgentOwner | null> {
    return parseAgentOwner((await this.redis?.get(this.presenceKey(deviceId))) ?? null);
  }

  private presenceKey(deviceId: string): string {
    return `${this.namespace}:presence:device:${deviceId}`;
  }

  private envelopeBase(
    _kind: RelayEnvelope['kind'],
    targetInstanceId: string | null,
    ttlMs: number,
  ): RelayEnvelopeBase {
    const now = Date.now();
    return {
      relayVersion: RELAY_VERSION,
      id: crypto.randomUUID(),
      sourceInstanceId: this.instanceId,
      targetInstanceId,
      createdAt: now,
      expiresAt: now + ttlMs,
    };
  }

  private async publishBestEffort(envelope: RelayEnvelope): Promise<boolean> {
    if (!this.distributed) return false;
    try {
      await this.start();
      if (this.redis === undefined) return false;
      await this.redis.publish(this.relayChannel, JSON.stringify(envelope));
      return true;
    } catch {
      return false;
    }
  }

  private broadcastJobLocally(userId: string, jobId: string, message: ServerToClientMessage): void {
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

  private broadcastDeviceLocally(userId: string, message: ServerToClientMessage): void {
    for (const client of this.clients.values()) {
      if (client.userId === userId) this.send(client.socket, message);
    }
  }

  private emitValidationResult(deviceId: string, result: RepositoryValidationResult): boolean {
    let handled = false;
    for (const listener of this.validationResultListeners) {
      try {
        handled = listener(deviceId, result) === true || handled;
      } catch {
        // A listener owns its request lifecycle; another instance may still handle the result.
      }
    }
    return handled;
  }

  private emitValidationCancel(deviceId: string): void {
    for (const listener of this.validationCancelListeners) {
      try {
        listener(deviceId);
      } catch {
        // Cancellation is best effort across instances.
      }
    }
  }

  private send(socket: WebSocket, message: ServerToAgentMessage | ServerToClientMessage): boolean {
    if (socket.readyState !== OPEN_STATE) return false;
    socket.send(JSON.stringify(message));
    return true;
  }

  private async performShutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const pending of this.pendingAcks.values()) {
      clearTimeout(pending.timeout);
      pending.resolve(false);
    }
    this.pendingAcks.clear();

    if (this.redis !== undefined) {
      await Promise.allSettled(
        [...this.agents.values()].map((connection) =>
          this.redis?.eval(
            releasePresenceScript,
            1,
            this.presenceKey(connection.deviceId),
            connection.presenceValue,
          ),
        ),
      );
    }
    for (const connection of this.agents.values()) {
      connection.socket.close(1001, 'server shutdown');
    }
    for (const connection of this.clients.values()) {
      connection.socket.close(1001, 'server shutdown');
    }
    this.agents.clear();
    this.clients.clear();
    this.validationResultListeners.clear();
    this.validationCancelListeners.clear();

    const redis = this.redis;
    const subscriber = this.subscriber;
    this.redis = undefined;
    this.subscriber = undefined;
    if (subscriber !== undefined) {
      subscriber.off('message', this.redisMessageHandler);
      subscriber.off('error', this.redisErrorHandler);
      await Promise.allSettled([subscriber.unsubscribe(this.relayChannel), subscriber.quit()]);
    }
    if (redis !== undefined) {
      redis.off('error', this.redisErrorHandler);
      await Promise.allSettled([redis.quit()]);
    }
  }
}

interface PendingValidation {
  deviceId: string;
  resolve: (result: RepositoryValidationResult) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export class RepositoryValidationBroker {
  private readonly pending = new Map<string, PendingValidation>();
  private readonly unsubscribeResult: () => void;
  private readonly unsubscribeCancel: () => void;

  constructor(
    private readonly connections: ConnectionHub,
    private readonly environment: ServerEnvironment,
  ) {
    this.unsubscribeResult = connections.onValidationResult((deviceId, result) =>
      this.settleLocal(deviceId, result),
    );
    this.unsubscribeCancel = connections.onValidationCancel((deviceId) =>
      this.cancelLocalForDevice(deviceId),
    );
  }

  async request(
    deviceId: string,
    repositoryId: string,
    absolutePath: string,
  ): Promise<RepositoryValidationResult> {
    if (this.pending.has(repositoryId)) {
      throw new AppError(
        409,
        'VALIDATION_IN_PROGRESS',
        'Repository validation is already running.',
      );
    }
    if (!(await this.connections.isAgentOnline(deviceId))) {
      throw new AppError(409, 'DEVICE_OFFLINE', 'The device must be online to validate a path.');
    }

    let resolvePending: (result: RepositoryValidationResult) => void = () => undefined;
    let rejectPending: (error: Error) => void = () => undefined;
    const resultPromise = new Promise<RepositoryValidationResult>((resolve, reject) => {
      resolvePending = resolve;
      rejectPending = reject;
    });
    const timeout = setTimeout(() => {
      this.pending.delete(repositoryId);
      rejectPending(
        new AppError(504, 'VALIDATION_TIMEOUT', 'The agent did not validate the path in time.'),
      );
    }, this.environment.REPOSITORY_VALIDATION_TIMEOUT_MS);
    timeout.unref();
    this.pending.set(repositoryId, {
      deviceId,
      resolve: resolvePending,
      reject: rejectPending,
      timeout,
    });

    const message: ServerToAgentMessage = createMessage('repository.validate', {
      repositoryId,
      absolutePath,
    });
    void this.connections
      .sendToAgent(deviceId, message)
      .then((sent) => {
        if (sent) return;
        const pending = this.pending.get(repositoryId);
        if (pending === undefined) return;
        clearTimeout(pending.timeout);
        this.pending.delete(repositoryId);
        pending.reject(
          new AppError(409, 'DEVICE_OFFLINE', 'The device disconnected before validation.'),
        );
      })
      .catch(() => undefined);
    return resultPromise;
  }

  async settle(deviceId: string, result: RepositoryValidationResult): Promise<boolean> {
    return this.connections.publishValidationResult(deviceId, result);
  }

  async cancelForDevice(deviceId: string): Promise<void> {
    await this.connections.publishValidationCancel(deviceId);
  }

  shutdown(): void {
    this.unsubscribeResult();
    this.unsubscribeCancel();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new AppError(503, 'SERVER_SHUTTING_DOWN', 'The server is shutting down.'));
    }
    this.pending.clear();
  }

  private settleLocal(deviceId: string, result: RepositoryValidationResult): boolean {
    const pending = this.pending.get(result.repositoryId);
    if (pending === undefined || pending.deviceId !== deviceId) return false;
    clearTimeout(pending.timeout);
    this.pending.delete(result.repositoryId);
    pending.resolve(result);
    return true;
  }

  private cancelLocalForDevice(deviceId: string): void {
    for (const [repositoryId, pending] of this.pending) {
      if (pending.deviceId !== deviceId) continue;
      clearTimeout(pending.timeout);
      this.pending.delete(repositoryId);
      pending.reject(
        new AppError(409, 'DEVICE_OFFLINE', 'The device disconnected during validation.'),
      );
    }
  }
}
