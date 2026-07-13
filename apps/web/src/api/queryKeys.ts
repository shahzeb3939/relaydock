export const queryKeys = {
  session: ['session'] as const,
  authConfig: ['auth-config'] as const,
  devices: ['devices'] as const,
  device: (deviceId: string) => ['devices', deviceId] as const,
  allRepositories: ['repositories'] as const,
  repository: (repositoryId: string) => ['repositories', repositoryId] as const,
  actions: (repositoryId: string) => ['repositories', repositoryId, 'actions'] as const,
  allJobs: ['jobs'] as const,
  jobs: (filters: object = {}) => ['jobs', filters] as const,
  job: (jobId: string) => ['jobs', jobId] as const,
  output: (jobId: string) => ['jobs', jobId, 'output'] as const,
};
