# RelayDock implementation progress

Last updated: 2026-07-12

## Repository state and constraints

- The starting repository contained only `initial.md`; there was no source code, package metadata, or Git repository.
- Available local tooling: Node.js 22, pnpm 10, Go 1.25, Docker Desktop with Compose, PostgreSQL 16 client tools, and Git.
- The implementation follows the requested pnpm monorepo, Fastify, React/Vite, PostgreSQL/Prisma, and Go-agent stack.
- Local integration requires Docker Desktop to be running. Interactive PTYs use Unix PTYs in the first release; Windows uses non-interactive process execution until ConPTY support is added.

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
- [ ] Add environment validation, Prisma schema, migrations, and PostgreSQL Compose service.
- [ ] Add protocol schemas and validation tests.

### Authentication and device connectivity

- [ ] Add Argon2id password authentication and secure database sessions.
- [ ] Add CSRF/origin protection and login rate limiting.
- [ ] Add pairing codes, hashed device credentials, revocation, and audit events.
- [ ] Add authenticated outbound agent WebSocket, heartbeat, and online state.

### Repositories, actions, and jobs

- [ ] Validate repository paths through the connected agent before enabling them.
- [ ] Add repository and action CRUD with user-scoped authorization.
- [ ] Dispatch jobs and enforce state transitions.
- [ ] Persist idempotent output chunks and enforce output retention limits.
- [ ] Add cancellation, output replay, and history.

### Agent

- [ ] Add pairing/config CLI with permission-restricted credential storage.
- [ ] Add reconnect with exponential backoff and jitter.
- [ ] Add repository path validation and root-bound working directory checks.
- [ ] Add non-interactive execution and bounded output buffering.
- [ ] Add PTY sessions, stdin, resize, persistence, and cancellation.
- [ ] Add macOS launchd, Linux systemd, and Windows service guidance.

### Mobile PWA

- [ ] Add authentication screens and protected navigation.
- [ ] Add devices, pairing, repositories, actions, jobs, and history screens.
- [ ] Add xterm.js terminal with reconnect/replay and mobile input controls.
- [ ] Add manifest, icons, service worker, and connectivity-aware offline screen.

### Hardening and packaging

- [ ] Add unit, integration, authorization, and end-to-end coverage.
- [ ] Add Docker images, production Compose, and reverse-proxy examples.
- [ ] Add structured logging, health/readiness, cleanup task, and graceful shutdown.
- [ ] Complete README, security, protocol, architecture, deployment, and troubleshooting docs.
- [ ] Run formatting, type checks, tests, builds, and the local smoke flow.

## Validation log

Validation results will be appended here after each major phase. Incomplete checks are never recorded as passing.
