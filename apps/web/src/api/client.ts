import type {
  Action,
  AuthConfig,
  CreateActionInput,
  CreateRepositoryInput,
  Device,
  DeviceDetails,
  Job,
  JobFilters,
  OutputChunk,
  PairingCode,
  Repository,
  Session,
} from './types';

interface ApiErrorBody {
  error?: {
    code?: string;
    message?: string;
    requestId?: string;
  };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;

  constructor(message: string, status: number, code = 'REQUEST_FAILED', requestId?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    if (requestId !== undefined) this.requestId = requestId;
  }
}

type RequestOptions = Omit<RequestInit, 'body'> & { body?: unknown };

function cookie(name: string): string | undefined {
  const prefix = `${encodeURIComponent(name)}=`;
  const match = document.cookie.split('; ').find((entry) => entry.startsWith(prefix));
  if (!match) return undefined;
  return decodeURIComponent(match.slice(prefix.length));
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = (options.method ?? 'GET').toUpperCase();
  const headers = new Headers(options.headers);
  const csrfToken = cookie('relaydock_csrf');

  if (options.body !== undefined) headers.set('content-type', 'application/json');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && csrfToken) {
    headers.set('x-csrf-token', csrfToken);
  }

  let response: Response;
  try {
    const { body, ...fetchOptions } = options;
    const init: RequestInit = {
      ...fetchOptions,
      credentials: 'include',
      headers,
      method,
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    response = await fetch(`/api${path}`, init);
  } catch {
    throw new ApiError(
      'RelayDock is unreachable. Check your connection and try again.',
      0,
      'OFFLINE',
    );
  }

  if (!response.ok) {
    if (response.status === 401) {
      window.dispatchEvent(new Event('relaydock:unauthorized'));
    }
    let body: ApiErrorBody = {};
    try {
      body = (await response.json()) as ApiErrorBody;
    } catch {
      // Some proxies replace JSON errors with an empty response.
    }
    const error = body.error;
    throw new ApiError(
      error?.message ?? `Request failed with status ${response.status}.`,
      response.status,
      error?.code ?? 'REQUEST_FAILED',
      error?.requestId,
    );
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function queryString(values: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => {
    if (value !== undefined && value !== '') params.set(key, value);
  });
  const query = params.toString();
  return query ? `?${query}` : '';
}

export const api = {
  async session(): Promise<Session | null> {
    try {
      return await request<Session>('/auth/session');
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return null;
      throw error;
    }
  },
  login(email: string, password: string) {
    return request<Session>('/auth/login', { method: 'POST', body: { email, password } });
  },
  register(email: string, password: string) {
    return request<Session>('/auth/register', { method: 'POST', body: { email, password } });
  },
  logout() {
    return request<void>('/auth/logout', { method: 'POST' });
  },
  authConfig() {
    return request<AuthConfig>('/auth/config');
  },
  async devices() {
    return (await request<{ devices: Device[] }>('/devices')).devices;
  },
  device(deviceId: string) {
    return request<DeviceDetails>(`/devices/${encodeURIComponent(deviceId)}`);
  },
  pairDevice() {
    return request<PairingCode>('/devices/pairing-codes', { method: 'POST' });
  },
  revokeDevice(deviceId: string) {
    return request<void>(`/devices/${encodeURIComponent(deviceId)}`, { method: 'DELETE' });
  },
  deleteDevice(deviceId: string) {
    return request<void>(`/devices/${encodeURIComponent(deviceId)}/permanent`, {
      method: 'DELETE',
    });
  },
  async repositories(deviceId: string) {
    return (
      await request<{ repositories: Repository[] }>(
        `/devices/${encodeURIComponent(deviceId)}/repositories`,
      )
    ).repositories;
  },
  async createRepository(deviceId: string, input: CreateRepositoryInput) {
    return (
      await request<{ repository: Repository }>(
        `/devices/${encodeURIComponent(deviceId)}/repositories`,
        { method: 'POST', body: input },
      )
    ).repository;
  },
  async repository(repositoryId: string) {
    return (
      await request<{ repository: Repository }>(`/repositories/${encodeURIComponent(repositoryId)}`)
    ).repository;
  },
  async updateRepository(
    repositoryId: string,
    input: Partial<CreateRepositoryInput> & { enabled?: boolean },
  ) {
    return (
      await request<{ repository: Repository }>(
        `/repositories/${encodeURIComponent(repositoryId)}`,
        {
          method: 'PATCH',
          body: input,
        },
      )
    ).repository;
  },
  deleteRepository(repositoryId: string) {
    return request<void>(`/repositories/${encodeURIComponent(repositoryId)}`, { method: 'DELETE' });
  },
  async actions(repositoryId: string) {
    return (
      await request<{ actions: Action[] }>(
        `/repositories/${encodeURIComponent(repositoryId)}/actions`,
      )
    ).actions;
  },
  async createAction(repositoryId: string, input: CreateActionInput) {
    return (
      await request<{ action: Action }>(
        `/repositories/${encodeURIComponent(repositoryId)}/actions`,
        { method: 'POST', body: input },
      )
    ).action;
  },
  deleteAction(actionId: string) {
    return request<void>(`/actions/${encodeURIComponent(actionId)}`, { method: 'DELETE' });
  },
  async jobs(filters: JobFilters = {}) {
    const suffix = queryString({
      deviceId: filters.deviceId,
      repositoryId: filters.repositoryId,
      status: filters.status,
    });
    return (await request<{ jobs: Job[] }>(`/jobs${suffix}`)).jobs;
  },
  async job(jobId: string) {
    return (await request<{ job: Job }>(`/jobs/${encodeURIComponent(jobId)}`)).job;
  },
  async output(jobId: string, afterSequence = -1) {
    const chunks: OutputChunk[] = [];
    let cursor = afterSequence;
    for (;;) {
      const batch = (
        await request<{ chunks: OutputChunk[] }>(
          `/jobs/${encodeURIComponent(jobId)}/output?afterSequence=${cursor}`,
        )
      ).chunks;
      chunks.push(...batch);
      if (batch.length < 1_000) break;
      const nextCursor = batch.reduce(
        (maximum, chunk) => Math.max(maximum, chunk.sequence),
        cursor,
      );
      if (nextCursor <= cursor) break;
      cursor = nextCursor;
    }
    return chunks;
  },
  async runAction(repositoryId: string, actionId: string, confirmation: boolean) {
    return (
      await request<{ job: Job }>(`/repositories/${encodeURIComponent(repositoryId)}/jobs`, {
        method: 'POST',
        body: { actionId, confirmation },
      })
    ).job;
  },
  async runCustomCommand(
    repositoryId: string,
    input: {
      command: string;
      workingDirectory?: string;
      interactive?: boolean;
      persistent?: boolean;
    },
  ) {
    return (
      await request<{ job: Job }>(`/repositories/${encodeURIComponent(repositoryId)}/jobs`, {
        method: 'POST',
        body: { ...input, confirmation: true },
      })
    ).job;
  },
  async cancelJob(jobId: string) {
    return (
      await request<{ job: Job }>(`/jobs/${encodeURIComponent(jobId)}/cancel`, {
        method: 'POST',
      })
    ).job;
  },
};
