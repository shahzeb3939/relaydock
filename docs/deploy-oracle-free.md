# Self-hosting the relay on a free always-on VM (Oracle Cloud Always Free)

RelayDock's live terminal needs a **persistent** WebSocket connection between the
browser, the server, and the agent. On Vercel the server runs as a serverless
Function, and **Vercel closes a WebSocket when the Function reaches its max
duration** (see [deployment.md](deployment.md)). That forced teardown is what
causes the repeated "live connection was interrupted", the frozen/stuck view,
and missing latest output — the browser *and* the agent get kicked on a timer
and spend part of every cycle reconnecting.

The fix is to run the server as a normal always-on process. The repo already
ships that deployment (`docker-compose.yml`: local Postgres + always-on server +
nginx web). This guide runs it at **zero recurring cost** on an Oracle Cloud
Always Free VM, behind Caddy for automatic HTTPS. No application code changes are
required — the only client-side change is **re-pairing the agent** at the new
address.

```
Internet :443
  └─ Caddy (automatic TLS)                 docker-compose.caddy.yml
       └─ web  (nginx: static app + proxy /api, /ws)   :8080
            └─ server (Fastify, always-on: migrate + node dist/index.js)  :3000
                 └─ postgres (local volume)            :5432
   Redis: not used (single instance → in-process routing)
```

> **Cost:** Always Free resources are $0 forever, but Oracle requires a credit
> card for identity verification (no charge). A free hostname (e.g. DuckDNS)
> covers TLS. Total recurring cost: $0.

> **Data note:** this stands up a **fresh** database on the VM. Your existing
> Vercel/Neon account, devices, and job history do **not** carry over — you
> create the account again and re-pair the agent. Keeping the database on the VM
> also keeps sensitive terminal output on infrastructure you control (weigh this
> against Emumba's ISMS data-classification policy with the control owner).

---

## 1. Provision the VM

In the Oracle Cloud console → **Compute → Instances → Create instance**:

- **Shape:** `VM.Standard.A1.Flex` (Ampere ARM, Always Free — up to 2 OCPU /
  12 GB is free). If you hit **"Out of host capacity"**, retry, switch
  Availability Domain/region, or try again later — the free ARM shape is often
  contended. (The AMD `VM.Standard.E2.1.Micro` is a fallback but only 1 GB RAM,
  which is tight for this stack.)
- **Image:** Ubuntu 22.04/24.04 (ARM) or Oracle Linux 9 (ARM).
- **SSH:** add your public key.
- Note the instance's **public IPv4** address.

Build the images **on this VM** (the Compose files do this): the ARM build
produces the matching `arm64` Prisma engine and native modules. Do not copy an
`x86` build over.

## 2. Open the firewall — in BOTH places

Oracle blocks traffic at two layers. You must open **80 and 443 in both**, or
TLS will silently fail.

1. **OCI Security List / NSG** (console → your VCN → Security Lists): add ingress
   rules allowing TCP **80** and **443** from `0.0.0.0/0`.
2. **The instance's own firewall.** Oracle's Ubuntu images ship an iptables rule
   that drops everything after the established-connection rules:

   ```bash
   sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
   sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
   sudo netfilter-persistent save
   ```

   On Oracle Linux (firewalld) instead:

   ```bash
   sudo firewall-cmd --permanent --add-service=http --add-service=https
   sudo firewall-cmd --reload
   ```

   Do **not** open 8080 — the web container stays on loopback behind Caddy.

## 3. Point a free hostname at the VM

Create a free subdomain (e.g. at [duckdns.org](https://www.duckdns.org)) and set
its address to the VM's public IPv4. Wait until it resolves:

```bash
dig +short relaydock-yourname.duckdns.org   # should print the VM IP
```

Caddy obtains a Let's Encrypt certificate automatically over port 80, so DNS must
resolve to the VM before you start the stack.

## 4. Install Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER" && newgrp docker   # log out/in to apply
docker compose version                              # confirm the plugin is present
```

## 5. Get the code and write the environment file

```bash
git clone https://github.com/shahzeb3939/relaydock.git
cd relaydock
```

Generate secrets **on the VM** (do not paste them into any chat/transcript):

```bash
openssl rand -hex 32   # RELAYDOCK_SESSION_PEPPER
openssl rand -hex 32   # RELAYDOCK_CREDENTIAL_PEPPER  (must differ from the above)
openssl rand -hex 24   # POSTGRES_PASSWORD
```

Create `.env` in the repo root:

```ini
# --- required ---
POSTGRES_PASSWORD=<the openssl rand -hex 24 value>
RELAYDOCK_DOMAIN=relaydock-yourname.duckdns.org
RELAYDOCK_WEB_ORIGIN=https://relaydock-yourname.duckdns.org
RELAYDOCK_SESSION_PEPPER=<first openssl rand -hex 32>
RELAYDOCK_CREDENTIAL_PEPPER=<second openssl rand -hex 32>

# keep the web container off the public interface (Caddy fronts it)
RELAYDOCK_HTTP_PORT=127.0.0.1:8080

# open registration only long enough to create your account (step 7), then off
RELAYDOCK_ALLOW_REGISTRATION=true

# --- optional ---
RELAYDOCK_PUBLIC_URL=https://relaydock-yourname.duckdns.org
RELAYDOCK_JOB_RETENTION_DAYS=30
RELAYDOCK_LOG_LEVEL=info
```

`RELAYDOCK_TRUST_PROXY` is already forced on for the server in Compose, so secure
cookies and origin checks work behind Caddy.

## 6. Start the stack

```bash
docker compose --profile app \
  -f docker-compose.yml -f docker-compose.caddy.yml \
  up -d --build
```

The first ARM build takes a few minutes. On start the server runs
`prisma migrate deploy` against the local database automatically. Watch it come
up healthy:

```bash
docker compose --profile app logs -f server   # wait for the ready log
curl -fsS https://relaydock-yourname.duckdns.org/ready   # {"status":"ready"}
```

If `/ready` fails, check `docker compose --profile app logs caddy` (usually DNS
not yet resolving, or port 80/443 still blocked at one of the two firewall
layers).

## 7. Create your account, then close registration

1. Open `https://relaydock-yourname.duckdns.org` and register the first account.
2. Set `RELAYDOCK_ALLOW_REGISTRATION=false` in `.env` and re-apply:

   ```bash
   docker compose --profile app \
     -f docker-compose.yml -f docker-compose.caddy.yml up -d
   ```

## 8. Re-pair the agent at the new address

The agent must now talk to the VM instead of the Vercel URL. In the web UI go to
**Devices → pair** to get a pairing code, then on the machine that runs the
agent:

```bash
curl -fsSL https://relaydock-yourname.duckdns.org/install-agent.sh | \
  sh -s -- --server https://relaydock-yourname.duckdns.org --code <PAIRING_CODE>
```

`--code` re-pairs the existing device against the new server. From now the agent
holds a single persistent WebSocket to your always-on host — no more periodic
teardown.

## 9. Verify the fix

- Log in, pair, and start an interactive job.
- Leave the terminal open for **>15 minutes**: the connection should stay **Live**
  with no "connection interrupted" banner (that was the serverless teardown).
- Send input mid-session — it should reach the command immediately.
- On mobile, the fullscreen-TUI swipe-to-navigate + on-screen ↑/↓/Enter (shipped
  separately) are in this same build.

---

## Optional: push notifications on the self-host

Push is **off by default** here (no VAPID keys → inert, which is safe). Do not
add empty VAPID variables — the server validates them and an empty value fails
startup. To enable push, generate keys per [notifications.md](notifications.md),
put all three in `.env`:

```ini
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:you@example.com
```

…and add a small overlay `docker-compose.push.yml` that passes them through only
when set (list form omits an unset variable, avoiding the empty-string trap):

```yaml
name: relaydock
services:
  server:
    environment:
      - VAPID_PUBLIC_KEY
      - VAPID_PRIVATE_KEY
      - VAPID_SUBJECT
```

Then append `-f docker-compose.push.yml` to the `up` command. All three are
required together.

## Operations

- **Logs:** `docker compose --profile app logs -f server`
- **Update:** `git pull` then re-run the step 6 `up -d --build` command;
  migrations apply automatically on server start.
- **Backup the database:**

  ```bash
  docker compose --profile app exec -T postgres \
    pg_dump -U relaydock relaydock | gzip > relaydock-$(date +%F).sql.gz
  ```

- **Monitor:** `GET /health` (process) and `/ready` (database).

## Rollback

The Vercel deployment is untouched. To revert, re-pair the agent back at the old
URL (`--server https://relaydock.vercel.app --code <code>`); the browser just
uses the old site again. The instability returns with it, so rollback is only a
stopgap.
