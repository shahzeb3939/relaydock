import { describe, expect, it } from 'vitest';
import { buildAgentInstallCommand } from './agentInstall';

describe('buildAgentInstallCommand', () => {
  it('builds a one-line installer command for the current RelayDock origin', () => {
    expect(buildAgentInstallCommand('https://relaydock.vercel.app', 'ABCD-EFGH')).toBe(
      "curl -fsSL 'https://relaydock.vercel.app/install-agent.sh' | sh -s -- --server 'https://relaydock.vercel.app' --code 'ABCD-EFGH'",
    );
  });

  it('removes trailing slashes and shell-quotes every dynamic argument', () => {
    expect(buildAgentInstallCommand("https://relay.example/o'malley///", "AB'C; echo unsafe")).toBe(
      "curl -fsSL 'https://relay.example/o'\\''malley/install-agent.sh' | sh -s -- --server 'https://relay.example/o'\\''malley' --code 'AB'\\''C; echo unsafe'",
    );
  });
});
