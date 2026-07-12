# Production deployment

RelayDock can run as two application containers plus PostgreSQL. The included Compose profile is a reference deployment, not an automatic cloud installer.

## Prepare configuration

```bash
cp .env.example .env
openssl rand -hex 32
openssl rand -hex 32
```

Set a unique database password, independent session and credential peppers, the public HTTPS URL, and the exact browser origin. Set `RELAYDOCK_ALLOW_REGISTRATION=true` only long enough to create the initial account.

```bash
docker compose --profile app up -d --build
```

The web container listens on host port 8080 by default and proxies `/api` and `/ws` to the server. Put that port behind Caddy, Nginx, or another maintained TLS reverse proxy. `docker/Caddyfile.example` shows the required routing. Preserve WebSocket `Upgrade`/`Connection` headers and use a long read timeout.

## TLS and network rules

- Expose only TCP 443 from the internet; redirect HTTP to HTTPS.
- Do not publish PostgreSQL publicly. The development port mapping should be removed or firewalled in production.
- Agents must use an `https://` URL, which becomes `wss://` for their sockets.
- Forward the original host and scheme so secure cookies and origin checks behave correctly.
- Apply upstream request limits no lower than the protocol's 256 KiB maximum WebSocket message.

## Migrations and upgrades

The server container applies checked-in Prisma migrations before startup. Before an upgrade, take a verified database backup, read migration changes, pull/build the new images, then restart. Roll back application code only when the migrated schema remains compatible; otherwise restore the matching database backup.

## Backup and retention

Back up PostgreSQL with your platform's encrypted snapshot facility or `pg_dump`; test restores. Job output is subject to both the per-job byte cap and `RELAYDOCK_JOB_RETENTION_DAYS`. The cleanup task removes expired job data but is not a substitute for a database lifecycle policy.

## Operations

- Monitor `/health` for process health and `/ready` for database readiness.
- Collect JSON logs from stdout and restrict access because commands and paths may be sensitive even though credentials are redacted.
- Revoke an agent immediately after a laptop loss or suspected credential exposure.
- Rotate server peppers only with a planned invalidation of all sessions/device credentials, then re-pair devices.
- Periodically restore a backup and test login, pairing, dispatch, WebSocket upgrade, and output replay.
