export const relayDockDefaults = {
  serverPort: 3000,
  heartbeatIntervalMs: 15_000,
  offlineAfterMs: 45_000,
  pairingCodeTtlMinutes: 10,
  sessionTtlHours: 168,
  jobRetentionDays: 30,
  maxRetainedOutputBytes: 10 * 1024 * 1024,
  agentBufferBytes: 4 * 1024 * 1024,
  commandTimeoutMs: 30_000,
} as const;

export const relayDockNames = {
  sessionCookie: 'relaydock_session',
  csrfHeader: 'x-csrf-token',
  configDirectory: '.config/relaydock',
  agentConfigFile: 'agent.json',
} as const;
