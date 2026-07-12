import { describe, expect, it } from 'vitest';

import {
  MAX_OUTPUT_CHUNK_BYTES,
  agentToServerMessageSchema,
  createMessage,
  serverToAgentMessageSchema,
} from './index.js';

describe('RelayDock protocol', () => {
  it('accepts a versioned job-start message', () => {
    const message = createMessage('job.start', {
      jobId: crypto.randomUUID(),
      repositoryId: crypto.randomUUID(),
      repositoryPath: '/tmp/repository',
      command: 'git status',
      workingDirectory: '.',
      interactive: false,
      persistent: false,
      shell: '/bin/zsh',
      shellArgs: ['-lc'],
      inheritedEnvironment: ['PATH'],
      columns: 80,
      rows: 24,
    });

    expect(serverToAgentMessageSchema.parse(message)).toEqual(message);
  });

  it('rejects unknown protocol versions', () => {
    const message = {
      ...createMessage('agent.heartbeat', { deviceId: crypto.randomUUID() }),
      version: 2,
    };

    expect(agentToServerMessageSchema.safeParse(message).success).toBe(false);
  });

  it('rejects oversized output chunks', () => {
    const message = createMessage('job.output', {
      jobId: crypto.randomUUID(),
      sequence: 0,
      stream: 'stdout',
      data: 'x'.repeat(MAX_OUTPUT_CHUNK_BYTES + 1),
    });

    expect(agentToServerMessageSchema.safeParse(message).success).toBe(false);
  });
});
