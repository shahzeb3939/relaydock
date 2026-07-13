import type { Server } from 'node:http';

import { buildServer } from './app.js';

const relayDock = await buildServer({ startMaintenance: false });
await relayDock.app.ready();

const server: Server = relayDock.app.server;

export default server;
