import { z } from 'zod';

export const PROTOCOL_VERSION = 1 as const;
export const MAX_PROTOCOL_MESSAGE_BYTES = 256 * 1024;
export const MAX_COMMAND_BYTES = 16 * 1024;
export const MAX_OUTPUT_CHUNK_BYTES = 64 * 1024;

const id = z.string().uuid();
const timestamp = z.string().datetime({ offset: true });

const envelope = <TType extends string, TPayload extends z.ZodTypeAny>(
  type: TType,
  payload: TPayload,
) =>
  z.object({
    version: z.literal(PROTOCOL_VERSION),
    type: z.literal(type),
    requestId: id,
    timestamp,
    payload,
  });

export const jobStatusSchema = z.enum([
  'queued',
  'dispatched',
  'running',
  'waiting_for_input',
  'completed',
  'failed',
  'cancelled',
  'disconnected',
]);

export const outputStreamSchema = z.enum(['stdout', 'stderr', 'system']);

const jobRef = z.object({ jobId: id });

export const agentToServerMessageSchema = z.discriminatedUnion('type', [
  envelope(
    'agent.hello',
    z.object({
      deviceId: id,
      name: z.string().min(1).max(100),
      platform: z.string().min(1).max(50),
      architecture: z.string().min(1).max(50),
      agentVersion: z.string().min(1).max(50),
      protocolVersions: z.array(z.literal(PROTOCOL_VERSION)).min(1),
      runningJobIds: z.array(id).max(100),
    }),
  ),
  envelope('agent.heartbeat', z.object({ deviceId: id })),
  envelope(
    'agent.status',
    z.object({
      deviceId: id,
      status: z.enum(['online', 'offline']),
      detail: z.string().max(500).optional(),
    }),
  ),
  envelope(
    'repository.validation.result',
    z.object({
      repositoryId: id,
      valid: z.boolean(),
      canonicalPath: z.string().max(4096).optional(),
      repositoryRoot: z.string().max(4096).optional(),
      isGitRepository: z.boolean(),
      branch: z.string().max(500).optional(),
      error: z.string().max(1000).optional(),
    }),
  ),
  envelope('job.accepted', jobRef),
  envelope('job.started', jobRef.extend({ pid: z.number().int().positive().optional() })),
  envelope(
    'job.output',
    jobRef.extend({
      sequence: z.number().int().nonnegative(),
      stream: outputStreamSchema,
      data: z.string().max(MAX_OUTPUT_CHUNK_BYTES),
    }),
  ),
  envelope(
    'job.status',
    jobRef.extend({ status: jobStatusSchema, detail: z.string().max(1000).optional() }),
  ),
  envelope('job.completed', jobRef.extend({ exitCode: z.number().int() })),
  envelope(
    'job.failed',
    jobRef.extend({ error: z.string().min(1).max(2000), exitCode: z.number().int().optional() }),
  ),
  envelope('job.cancelled', jobRef),
  envelope(
    'job.input.acknowledged',
    jobRef.extend({ inputSequence: z.number().int().nonnegative() }),
  ),
  envelope(
    'job.buffer.sync',
    jobRef.extend({
      chunks: z
        .array(
          z.object({
            sequence: z.number().int().nonnegative(),
            stream: outputStreamSchema,
            data: z.string().max(MAX_OUTPUT_CHUNK_BYTES),
          }),
        )
        .max(1000),
    }),
  ),
]);

export const serverToAgentMessageSchema = z.discriminatedUnion('type', [
  envelope(
    'agent.welcome',
    z.object({
      deviceId: id,
      heartbeatIntervalMs: z.number().int().min(1000),
      serverTime: timestamp,
    }),
  ),
  envelope(
    'repository.validate',
    z.object({ repositoryId: id, absolutePath: z.string().min(1).max(4096) }),
  ),
  envelope(
    'job.start',
    z.object({
      jobId: id,
      repositoryId: id,
      repositoryPath: z.string().min(1).max(4096),
      command: z.string().min(1).max(MAX_COMMAND_BYTES),
      workingDirectory: z.string().max(4096),
      interactive: z.boolean(),
      persistent: z.boolean(),
      shell: z.string().min(1).max(4096),
      shellArgs: z.array(z.string().max(1000)).max(20),
      inheritedEnvironment: z.array(z.string().max(200)).max(100),
      columns: z.number().int().min(10).max(1000),
      rows: z.number().int().min(2).max(1000),
    }),
  ),
  envelope(
    'job.input',
    jobRef.extend({
      inputSequence: z.number().int().nonnegative(),
      data: z.string().max(64 * 1024),
    }),
  ),
  envelope(
    'job.resize',
    jobRef.extend({
      columns: z.number().int().min(10).max(1000),
      rows: z.number().int().min(2).max(1000),
    }),
  ),
  envelope('job.cancel', jobRef),
  envelope('job.buffer.request', jobRef.extend({ afterSequence: z.number().int().min(-1) })),
]);

export const serverToClientMessageSchema = z.discriminatedUnion('type', [
  envelope(
    'device.status',
    z.object({
      deviceId: id,
      status: z.enum(['online', 'offline', 'revoked']),
      lastSeenAt: timestamp,
    }),
  ),
  envelope(
    'job.status',
    jobRef.extend({ status: jobStatusSchema, exitCode: z.number().int().nullable().optional() }),
  ),
  envelope(
    'job.output',
    jobRef.extend({
      sequence: z.number().int().nonnegative(),
      stream: outputStreamSchema,
      data: z.string().max(MAX_OUTPUT_CHUNK_BYTES),
    }),
  ),
  envelope('job.completed', jobRef.extend({ exitCode: z.number().int() })),
  envelope(
    'job.failed',
    jobRef.extend({
      error: z.string().max(2000),
      exitCode: z.number().int().nullable().optional(),
    }),
  ),
]);

export const clientToServerMessageSchema = z.discriminatedUnion('type', [
  envelope('job.subscribe', jobRef.extend({ afterSequence: z.number().int().min(-1).default(-1) })),
  envelope('job.unsubscribe', jobRef),
  envelope(
    'job.input',
    jobRef.extend({
      inputSequence: z.number().int().nonnegative(),
      data: z.string().max(64 * 1024),
    }),
  ),
  envelope(
    'job.resize',
    jobRef.extend({
      columns: z.number().int().min(10).max(1000),
      rows: z.number().int().min(2).max(1000),
    }),
  ),
  envelope('job.cancel', jobRef),
]);

export const protocolMessageSchema = z.union([
  agentToServerMessageSchema,
  serverToAgentMessageSchema,
  serverToClientMessageSchema,
  clientToServerMessageSchema,
]);

export type AgentToServerMessage = z.infer<typeof agentToServerMessageSchema>;
export type ServerToAgentMessage = z.infer<typeof serverToAgentMessageSchema>;
export type ServerToClientMessage = z.infer<typeof serverToClientMessageSchema>;
export type ClientToServerMessage = z.infer<typeof clientToServerMessageSchema>;
export type JobStatus = z.infer<typeof jobStatusSchema>;
export type OutputStream = z.infer<typeof outputStreamSchema>;

export function createMessage<T extends string, P>(type: T, payload: P) {
  return {
    version: PROTOCOL_VERSION,
    type,
    requestId: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    payload,
  } as const;
}
