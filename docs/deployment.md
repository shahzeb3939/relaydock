# Production deployment

RelayDock can run as two application containers plus PostgreSQL. The included Compose profile is a reference deployment, not an automatic cloud installer.

It can also run as a Vercel Services deployment using the root `vercel.json`. That deployment uses a Vite static service, a Fastify Function, managed PostgreSQL, and Redis-backed presence and fan-out.

## Prepare configuration

```bash
cp .env.example .env
openssl rand -hex 32
openssl rand -hex 32
```

Set a unique database password, independent session and credential peppers, and `RELAYDOCK_WEB_ORIGIN` to the exact public HTTPS origin. Set `RELAYDOCK_ALLOW_REGISTRATION=true` only long enough to create the initial account.

```bash
docker compose --profile app up -d --build
```

The web container listens on host port 8080 by default and proxies `/api` and `/ws` to the server. Put that port behind Caddy, Nginx, or another maintained TLS reverse proxy. `docker/Caddyfile.example` shows the required routing. Preserve WebSocket `Upgrade`/`Connection` headers and use a long read timeout.

## Vercel

Create and link one Vercel project, then provision PostgreSQL and Redis from the Marketplace. The example below keeps both data services in Singapore and disables Upstash's automatic paid-plan upgrade.

```bash
pnpm dlx vercel@55.0.0 project add relaydock
pnpm dlx vercel@55.0.0 link --yes --project relaydock
pnpm dlx vercel@55.0.0 integration add neon \
  --name relaydock-postgres --plan free_v3 \
  --metadata region=sin1 --metadata auth=false \
  --environment production --no-env-pull
pnpm dlx vercel@55.0.0 integration add upstash/upstash-kv \
  --name relaydock-redis --plan free \
  --metadata primaryRegion=sin1 --metadata eviction=false \
  --metadata prodPack=false --metadata autoUpgrade=false \
  --environment production --no-env-pull
```

The integrations inject `DATABASE_URL` and `REDIS_URL`. Add these application variables to Production:

- `NODE_ENV=production`
- `RELAYDOCK_WEB_ORIGIN=https://<production-domain>`
- `RELAYDOCK_TRUST_PROXY=true`
- `RELAYDOCK_REDIS_NAMESPACE=relaydock-production`
- independent random `RELAYDOCK_SESSION_PEPPER` and `RELAYDOCK_CREDENTIAL_PEPPER` values
- a random `CRON_SECRET` for Vercel Cron authentication
- `RELAYDOCK_ALLOW_REGISTRATION=true` only until the first account is created

Apply migrations with Neon's unpooled URL, then deploy the Function in the same region as the data services:

```bash
pnpm dlx vercel@55.0.0 env run --environment production -- \
  sh -c 'DATABASE_URL="$DATABASE_URL_UNPOOLED" pnpm --filter @relaydock/server prisma:deploy'
pnpm dlx vercel@55.0.0 deploy --prod --regions sin1
```

Vercel WebSockets and Services are Beta features. A WebSocket closes when its Function reaches the plan's maximum duration; the agent and web client reconnect automatically, while PostgreSQL and Redis preserve shared state between Function instances.

## TLS and network rules

- Expose only TCP 443 from the internet; redirect HTTP to HTTPS.
- Do not publish PostgreSQL publicly. The included development mapping is loopback-only; remove it entirely in production when host access is unnecessary.
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
