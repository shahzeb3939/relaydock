import type { JobStatus, OutputStream } from '@relaydock/protocol';

export interface User {
  id: string;
  email: string;
  createdAt: string;
}

export interface Session {
  user: User;
  csrfToken: string;
}

export interface AuthConfig {
  google: boolean;
  allowRegistration: boolean;
}

export interface PushConfig {
  enabled: boolean;
  publicKey: string | null;
}

export type DeviceStatus = 'online' | 'offline' | 'revoked';

export interface Device {
  id: string;
  name: string;
  platform: string;
  architecture: string;
  agentVersion: string;
  status: DeviceStatus;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
  repositoryCount?: number;
}

export interface Repository {
  id: string;
  deviceId: string;
  name: string;
  absolutePath: string;
  description: string | null;
  enabled: boolean;
  allowCustomCommands: boolean;
  shell: string;
  shellArgs: string[];
  inheritedEnvironment: string[];
  isGitRepository?: boolean;
  branch?: string | null;
  createdAt: string;
  updatedAt: string;
  device?: Pick<Device, 'id' | 'name' | 'status'>;
}

export interface Action {
  id: string;
  repositoryId: string;
  name: string;
  command: string;
  workingDirectory: string;
  interactive: boolean;
  persistent: boolean;
  confirmationRequired: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Job {
  id: string;
  deviceId: string;
  repositoryId: string;
  actionId: string | null;
  command: string;
  workingDirectory: string;
  status: JobStatus;
  interactive: boolean;
  persistent: boolean;
  exitCode: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  repository?: Pick<Repository, 'id' | 'name'>;
  device?: Pick<Device, 'id' | 'name'>;
}

export interface OutputChunk {
  sequence: number;
  stream: OutputStream;
  data: string;
  timestamp?: string;
}

export interface DeviceDetails {
  device: Device;
  repositories: Repository[];
  recentJobs: Job[];
}

export interface PairingCode {
  code: string;
  expiresAt: string;
}

export interface CreateRepositoryInput {
  name: string;
  absolutePath: string;
  description?: string;
  allowCustomCommands?: boolean;
  shell?: string;
  shellArgs?: string[];
  inheritedEnvironment?: string[];
}

export interface CreateActionInput {
  name: string;
  command: string;
  workingDirectory?: string;
  interactive?: boolean;
  persistent?: boolean;
  confirmationRequired?: boolean;
}

export interface JobFilters {
  deviceId?: string;
  repositoryId?: string;
  status?: JobStatus;
  limit?: number;
}
