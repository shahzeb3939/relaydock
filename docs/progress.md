# RelayDock implementation progress

Last updated: 2026-07-13

## Repository state and constraints

- The starting repository contained only `initial.md`; there was no source code, package metadata, or Git repository.
- Available local tooling: Node.js 22, pnpm 10, Go 1.25, Docker Desktop with Compose, PostgreSQL 16 client tools, and Git.
- The implementation follows the requested pnpm monorepo, Fastify, React/Vite, PostgreSQL/Prisma, and Go-agent stack.
- The documented quick start uses Docker for PostgreSQL; verification also works with any reachable PostgreSQL 16 instance. Interactive PTYs use Unix PTYs in the first release; Windows uses non-interactive process execution until ConPTY support is added.

## First vertical slice

The first operational slice is:

1. Register or sign in.
2. Generate a one-time device pairing code.
3. Pair the outbound-only Go agent and authenticate its WebSocket.
4. Ask the connected agent to validate a repository path.
5. Create a predefined action.
6. Dispatch a command to the agent.
7. Stream sequence-numbered output through the server and persist it.
8. Reopen the job and replay retained output.

Interactive PTY input, resize, cancellation, and agent-side reconnect buffering build on the same protocol.

## Checklist

### Foundation

- [x] Inspect starting repository and available tooling.
- [x] Select the vertical slice and record architecture decisions.
- [x] Initialize pnpm workspace and strict TypeScript configuration.
- [x] Add environment validation, Prisma schema, migrations, and PostgreSQL Compose service.
- [x] Add protocol schemas and validation tests.

### Authentication and device connectivity

- [x] Add Argon2id password authentication and secure database sessions.
- [x] Add CSRF/origin protection and login rate limiting.
- [x] Add pairing codes, hashed device credentials, revocation, and audit events.
- [x] Allow revoked devices and their operational data to be permanently deleted.
- [x] Add authenticated outbound agent WebSocket, heartbeat, and online state.

### Repositories, actions, and jobs

- [x] Validate repository paths through the connected agent before enabling them.
- [x] Add repository and action CRUD with user-scoped authorization.
- [x] Dispatch jobs and enforce state transitions.
- [x] Persist idempotent output chunks and enforce output retention limits.
- [x] Add cancellation, output replay, and history.

### Agent

- [x] Add pairing/config CLI with permission-restricted credential storage.
- [x] Add reconnect with exponential backoff and jitter.
- [x] Add repository path validation and root-bound working directory checks.
- [x] Add non-interactive execution and bounded output buffering.
- [x] Add PTY sessions, stdin, resize, persistence, and cancellation.
- [x] Add macOS launchd, Linux systemd, and Windows service guidance.
- [x] Add checksum-verified prebuilt macOS/Linux distributions and automatic user-service installation.

### Mobile PWA

- [x] Add authentication screens and protected navigation.
- [x] Add devices, pairing, repositories, actions, jobs, and history screens.
- [x] Add xterm.js terminal with reconnect/replay and mobile input controls.
- [x] Add manifest, icons, service worker, and connectivity-aware offline screen.

### Hardening and packaging

- [x] Add unit tests and live integration, authorization, and end-to-end verification.
- [ ] Convert the live vertical-slice verification into a hermetic automated integration test.
- [x] Add Docker images, production Compose, and reverse-proxy examples.
- [x] Add structured logging, health/readiness, cleanup task, and graceful shutdown.
- [x] Complete README, security, protocol, architecture, deployment, and troubleshooting docs.
- [x] Run formatting, type checks, tests, builds, and the local smoke flow.
- [ ] Complete a container image build when Docker Hub base-image metadata is reachable.

## Validation log

### Automated checks

- `pnpm format:check`: passed.
- `pnpm lint`: passed strict TypeScript checks for all packages/apps plus `go vet ./...`.
- `pnpm test`: passed all TypeScript/Vitest suites, every Go package test, and the agent bootstrap tests.
- `pnpm test:agent:race`: passed for all Go packages.
- `pnpm build`: passed protocol/config/shared/server/web production builds and the native agent build.
- Deterministic cross-compilation and checksum regeneration passed for macOS and Linux on amd64 and arm64.
- The no-prerequisite bootstrap passed platform selection, argument forwarding, root/HTTP rejection, checksum failure, and version failure tests.
- The production service worker's shell-asset discovery matched every hashed entry asset.
- Prisma schema validation and the initial migration against isolated PostgreSQL 16 passed.
- `docker compose --profile app config --quiet`: passed with production-like settings.

### Live vertical slice

An isolated PostgreSQL 16 cluster, a real Fastify server, and the compiled Go agent were exercised locally. The following passed:

1. Register, restore a secure cookie session, and enforce CSRF/origin checks.
2. Generate and consume a one-time pairing code; reject its reuse.
3. Store the agent config as `0600`, authenticate the outbound WebSocket, and show the device online.
4. Validate this Git checkout through the agent and store its canonical path and branch.
5. Create and run predefined and opt-in custom commands; persist stdout and exit code.
6. Open an interactive PTY, resize it, send input, close the WebSocket, reopen it, replay output, send a second input with a new sequence, and complete.
7. Stop the server during a running job, retain output in the agent, reconnect with backoff, idempotently synchronize missing chunks, and finalize the job.
8. Cancel a running process and record the cancelled state in history.
9. Reject a second user's access to another user's device, repository, job, and output.
10. Revoke the device, close its active socket, and reject every reconnect with HTTP 401.

The Docker image build reached Docker Hub metadata resolution but the registry request did not complete within the bounded verification window. Compose interpolation and structure are validated; the image build remains explicitly unchecked above.
