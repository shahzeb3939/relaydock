import type { Action, Device, Job, Repository } from '@prisma/client';

import { jsonStringArray } from './domain.js';

function timestamp(date: Date): string {
  return date.toISOString();
}

export function serializeUser(user: { id: string; email: string; createdAt: Date }) {
  return { id: user.id, email: user.email, createdAt: timestamp(user.createdAt) };
}

export function serializeDevice(device: Device & { _count?: { repositories: number } }) {
  return {
    id: device.id,
    name: device.name,
    platform: device.platform,
    architecture: device.architecture,
    agentVersion: device.agentVersion,
    status: device.status,
    lastSeenAt: timestamp(device.lastSeenAt ?? device.createdAt),
    createdAt: timestamp(device.createdAt),
    updatedAt: timestamp(device.updatedAt),
    ...(device._count === undefined ? {} : { repositoryCount: device._count.repositories }),
  };
}

export function serializeRepository(
  repository: Repository & { device?: Pick<Device, 'id' | 'name' | 'status'> },
) {
  return {
    id: repository.id,
    deviceId: repository.deviceId,
    name: repository.name,
    absolutePath: repository.absolutePath,
    description: repository.description,
    enabled: repository.enabled,
    allowCustomCommands: repository.allowCustomCommands,
    shell: repository.shell,
    shellArgs: jsonStringArray(repository.shellArgs),
    inheritedEnvironment: jsonStringArray(repository.inheritedEnvironment),
    ...(repository.isGitRepository === null ? {} : { isGitRepository: repository.isGitRepository }),
    branch: repository.branch,
    createdAt: timestamp(repository.createdAt),
    updatedAt: timestamp(repository.updatedAt),
    ...(repository.device === undefined
      ? {}
      : {
          device: {
            id: repository.device.id,
            name: repository.device.name,
            status: repository.device.status,
          },
        }),
  };
}

export function serializeAction(action: Action) {
  return {
    id: action.id,
    repositoryId: action.repositoryId,
    name: action.name,
    command: action.command,
    workingDirectory: action.workingDirectory,
    interactive: action.interactive,
    persistent: action.persistent,
    confirmationRequired: action.confirmationRequired,
    createdAt: timestamp(action.createdAt),
    updatedAt: timestamp(action.updatedAt),
  };
}

export function serializeJob(
  job: Job & {
    repository?: { id: string; name: string };
    device?: { id: string; name: string };
  },
) {
  return {
    id: job.id,
    deviceId: job.deviceId,
    repositoryId: job.repositoryId,
    actionId: job.actionId,
    command: job.command,
    workingDirectory: job.workingDirectory,
    status: job.status,
    interactive: job.interactive,
    persistent: job.persistent,
    exitCode: job.exitCode,
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
    createdAt: timestamp(job.createdAt),
    updatedAt: timestamp(job.updatedAt),
    ...(job.repository === undefined
      ? {}
      : { repository: { id: job.repository.id, name: job.repository.name } }),
    ...(job.device === undefined ? {} : { device: { id: job.device.id, name: job.device.name } }),
  };
}

export function serializeOutputChunk(chunk: {
  sequence: number;
  stream: 'stdout' | 'stderr' | 'system';
  data: string;
  timestamp?: Date;
}) {
  return {
    sequence: chunk.sequence,
    stream: chunk.stream,
    data: chunk.data,
    ...(chunk.timestamp === undefined ? {} : { timestamp: timestamp(chunk.timestamp) }),
  };
}
