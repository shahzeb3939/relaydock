import { buildServer } from './app.js';

const server = await buildServer();
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  server.app.log.info({ signal }, 'graceful shutdown started');
  const forcedExit = setTimeout(() => {
    server.app.log.fatal('graceful shutdown timed out');
    process.exit(1);
  }, 10_000);
  forcedExit.unref();
  try {
    await server.app.close();
    clearTimeout(forcedExit);
  } catch (error) {
    server.app.log.error({ err: error }, 'graceful shutdown failed');
    process.exitCode = 1;
  }
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await server.app.listen({ host: server.environment.HOST, port: server.environment.PORT });
} catch (error) {
  server.app.log.fatal({ err: error }, 'server failed to start');
  await server.app.close();
  process.exitCode = 1;
}
