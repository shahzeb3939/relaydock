function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function buildAgentInstallCommand(origin: string, pairingCode: string): string {
  const serverOrigin = origin.replace(/\/+$/, '');
  const installerUrl = `${serverOrigin}/install-agent.sh`;

  return `curl -fsSL ${shellQuote(installerUrl)} | sh -s -- --server ${shellQuote(serverOrigin)} --code ${shellQuote(pairingCode)}`;
}
