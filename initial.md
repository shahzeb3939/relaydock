A suitable name is **RelayDock**.

It communicates the core idea clearly:

* **Relay**: securely relays instructions from your phone to your laptop.
* **Dock**: a home base for repositories, sessions, and running jobs.
* It is broad enough to support Codex, Claude Code, shell commands, tests, and deployments later.

Below is a complete Codex prompt designed to produce a usable MVP rather than merely generate an architectural prototype.

You are a senior full-stack engineer, security engineer, product architect, and open-source maintainer. Build an MVP for a project named **RelayDock**.

# Product definition

RelayDock is a self-hostable remote command execution system for developers.

It allows a user to leave a laptop running, open RelayDock from a mobile phone, select a registered repository, submit a command or predefined action, and watch the output stream live from the laptop.

The intended experience is similar to an agent-based remote-control system:

1. A lightweight agent runs on the user’s laptop.
2. The laptop agent establishes an outbound encrypted connection to a RelayDock server.
3. The user opens a mobile-friendly web application.
4. The user selects their laptop and repository.
5. The user runs an approved command or enters a custom command.
6. The laptop agent executes it in that repository.
7. Standard output, standard error, status changes, and exit codes stream back to the web application.
8. Long-running jobs continue even when the mobile browser disconnects.
9. The user can reconnect and view the current state and previous output.

The laptop must not require:

* A public IP address
* Router port forwarding
* An inbound SSH server
* Tailscale
* A directly exposed local web server

The laptop agent should initiate all network connections outbound.

# Primary use case

The primary use case is remotely running AI coding agents and development commands in specific repositories while the user’s laptop is powered on and connected to the internet.

Examples:

```bash
codex
```

```bash
claude
```

```bash
npm test
```

```bash
git status
```

```bash
git pull
```

```bash
docker compose up
```

Example workflow:

1. The user opens RelayDock on their phone.
2. The user selects “MacBook Pro.”
3. The user selects the “MVP” repository.
4. The user chooses the “Continue with Codex” action.
5. RelayDock starts or reconnects to a persistent session.
6. The command runs in the configured repository.
7. Live output appears on the phone.
8. The user can send additional input to the running process.
9. The user closes the mobile browser.
10. The process remains alive.
11. The user returns later and reconnects to the same session.

# MVP scope

Build a functional end-to-end MVP containing:

1. A central server
2. A laptop agent
3. A mobile-responsive web application
4. User authentication
5. Device registration
6. Repository registration
7. Predefined actions
8. Custom command execution
9. Persistent interactive sessions
10. Live output streaming
11. Command history
12. Basic security controls
13. Local development setup
14. Docker-based deployment
15. Documentation

Do not build native iOS or Android applications in the MVP. Build a progressive, mobile-responsive web application that works well when saved to the phone’s home screen.

# Preferred technology stack

Use this stack unless the existing repository strongly indicates another appropriate stack:

## Monorepo

Use:

```text
pnpm workspaces
```

Organize the repository as:

```text
relaydock/
  apps/
    server/
    web/
    agent/
  packages/
    protocol/
    config/
    shared/
  docs/
  docker/
```

## Server

Use:

* Node.js
* TypeScript
* Fastify
* WebSocket support
* PostgreSQL
* Prisma ORM
* Zod for runtime validation
* Argon2id for password hashing
* JWT or secure database-backed sessions
* Pino structured logging

## Web application

Use:

* React
* TypeScript
* Vite
* React Router
* TanStack Query
* A lightweight accessible component system
* Plain CSS, CSS modules, or Tailwind CSS
* xterm.js for terminal output and interactive sessions

The web interface must be strongly optimized for mobile screens.

## Laptop agent

Prefer:

* Go

The Go agent should compile into a single executable for macOS, Linux, and Windows.

Use a Node.js agent only when implementing the Go agent would materially block the end-to-end MVP. If a Node.js agent is used initially, define a clean protocol so it can later be replaced by Go.

## Communication

Use:

* HTTPS
* Secure WebSockets
* JSON messages initially
* Strictly versioned and validated protocol messages

Define all protocol messages centrally.

# Architecture

Implement the following architecture:

```text
Mobile browser
      |
      | HTTPS / secure WebSocket
      v
RelayDock server
      ^
      | outbound secure WebSocket
      |
Laptop agent
      |
      v
Local repositories and processes
```

The server acts as an authenticated relay and persistence layer.

The laptop agent establishes an outbound WebSocket connection to the server and keeps it alive using heartbeat messages.

The web client never connects directly to the laptop.

# Domain model

At minimum, implement the following entities.

## User

Fields:

* id
* email
* passwordHash
* createdAt
* updatedAt

## Device

Fields:

* id
* userId
* name
* platform
* architecture
* agentVersion
* status
* lastSeenAt
* createdAt
* updatedAt

Possible status values:

* online
* offline
* revoked

## DeviceCredential

Store hashed device credentials, not raw reusable tokens.

Fields:

* id
* deviceId
* credentialHash
* createdAt
* lastUsedAt
* revokedAt

## Repository

Fields:

* id
* deviceId
* name
* absolutePath
* description
* enabled
* createdAt
* updatedAt

## Action

A predefined command associated with a repository.

Fields:

* id
* repositoryId
* name
* command
* workingDirectory
* interactive
* persistent
* confirmationRequired
* createdAt
* updatedAt

Examples:

```text
Name: Continue with Codex
Command: codex
Interactive: true
Persistent: true
```

```text
Name: Run tests
Command: pnpm test
Interactive: false
Persistent: false
```

## Job

Fields:

* id
* userId
* deviceId
* repositoryId
* actionId, nullable
* command
* workingDirectory
* status
* interactive
* persistent
* exitCode, nullable
* startedAt
* finishedAt, nullable
* createdAt
* updatedAt

Possible status values:

* queued
* dispatched
* running
* waiting_for_input
* completed
* failed
* cancelled
* disconnected

## JobOutputChunk

Fields:

* id
* jobId
* sequence
* stream
* data
* timestamp

Possible stream values:

* stdout
* stderr
* system

Do not store secrets from environment variables in job records.

# Authentication

Implement email and password authentication for the web application.

Requirements:

* Passwords must use Argon2id.
* Authentication cookies must be `HttpOnly`.
* Cookies must use `Secure` in production.
* Set an appropriate `SameSite` policy.
* Add CSRF protection when required by the selected session model.
* Apply login rate limiting.
* Do not expose authentication tokens in browser local storage.
* Include logout and session invalidation.
* All database queries must be scoped to the authenticated user.

For an initial self-hosted MVP, account registration may be controlled by an environment variable:

```text
ALLOW_REGISTRATION=true
```

# Device pairing

Implement a secure device-pairing workflow.

Suggested flow:

1. The authenticated user clicks “Add device.”
2. The server generates:

   * A short pairing code
   * A one-time pairing token
   * An expiration time of approximately 10 minutes
3. The user runs:

```bash
relaydock-agent pair --server https://relay.example.com --code ABCD-EFGH
```

4. The agent exchanges the pairing code for a long-lived device credential.
5. The raw device credential is shown to the agent only once.
6. The server stores only a secure hash of that credential.
7. The agent stores its credential using the operating system’s secure credential store where practical.
8. The pairing code immediately becomes invalid after use.
9. The user can revoke a device from the web interface.

For the first MVP, a permission-restricted configuration file may be used as a fallback:

```text
~/.config/relaydock/agent.json
```

On Unix systems, require file permissions equivalent to:

```text
0600
```

Clearly mark this fallback in the documentation.

# Agent requirements

The laptop agent must:

* Run as a foreground process during development.
* Support installation as a background service.
* Connect outward to the configured server.
* Authenticate using its device credential.
* Send its device metadata.
* Maintain a heartbeat.
* Automatically reconnect with exponential backoff and jitter.
* Receive job-start messages.
* Validate every received message.
* Confirm that the requested repository belongs to the connected device.
* Resolve the working directory safely.
* Reject paths outside registered repository roots.
* Start commands.
* Stream stdout and stderr.
* Report exit codes.
* Accept stdin for interactive jobs.
* Support terminal resizing.
* Support cancellation.
* Recover gracefully after temporary network interruption.
* Report agent version and supported protocol version.
* Never execute a job belonging to another device or user.

# Persistent and interactive sessions

This is a critical part of the project.

The MVP must support commands such as Codex and Claude Code that require:

* A pseudo-terminal
* Interactive input
* Terminal resize events
* Long-running sessions
* Reconnection after the browser disconnects

On Unix-like systems, use a pseudo-terminal implementation.

Select one of the following approaches:

## Preferred approach

The agent directly manages PTY processes and keeps them alive in its own process.

Store an in-memory session registry keyed by job ID.

The session registry should track:

* PTY process
* Process ID
* Current status
* Connected viewers
* Output sequence number
* Start time
* Last activity
* Terminal dimensions

## Acceptable MVP alternative

Use `tmux` as an optional Unix backend for persistent sessions.

If using tmux:

* Detect whether tmux is installed.
* Clearly report when it is unavailable.
* Create isolated sessions named using RelayDock job IDs.
* Do not interpolate untrusted strings into tmux commands.
* Use safe argument passing.
* Document that Windows support will use a different persistence backend.

The direct PTY approach is preferred because RelayDock should eventually work without an external tmux dependency.

# Reconnection behavior

When a mobile client disconnects:

* The job must continue running.
* The agent must keep reading process output.
* The server must retain recent output.
* When the client reconnects, it should request output after its last known sequence number.
* The server should return missing output chunks.
* The client should then resume live streaming.

When the laptop agent temporarily loses connection:

* A running local job should not automatically be killed.
* The agent should buffer a bounded amount of output locally.
* On reconnection, it should send missing output chunks.
* Use monotonically increasing sequence numbers.
* Avoid duplicate display by making output delivery idempotent.
* Document the memory and disk limits used for buffering.

For the MVP, use a bounded in-memory buffer with an explicit maximum and document the limitation. Structure the code so disk-backed buffering can be added later.

# Command execution model

RelayDock should support two execution modes.

## Predefined actions

These are configured ahead of time and are the safest option.

Examples:

```text
Continue with Codex
Run tests
Git status
Pull changes
Start development server
```

## Custom commands

Custom commands should be disabled by default and enabled per device or per repository.

Add a setting such as:

```text
allowCustomCommands: false
```

When custom commands are enabled:

* Display a visible warning.
* Show the exact command before dispatch.
* Require confirmation.
* Record the command in job history.
* Never automatically add `sudo`.
* Never run through an unnecessary shell when direct process execution is possible.

Because arbitrary shell syntax may be required, support an explicit shell execution mode:

```text
/bin/zsh -lc "<command>"
```

or:

```text
/bin/bash -lc "<command>"
```

The shell must be configurable by repository.

Treat custom commands as inherently privileged.

# Security boundaries

Security is a first-class requirement.

Implement and document these protections:

1. The agent only accepts authenticated server messages.
2. The server only accepts authenticated agents.
3. Every job must be authorized for:

   * The user
   * The device
   * The repository
4. Repository paths must be registered locally by the agent or explicitly confirmed during registration.
5. Reject path traversal.
6. Reject working directories outside the registered repository.
7. Device credentials must be revocable.
8. Pairing tokens must be one-time and short-lived.
9. Apply server-side rate limits.
10. Apply reasonable command-size and output-size limits.
11. Limit WebSocket message sizes.
12. Validate every protocol message.
13. Never log:

    * Passwords
    * Raw device credentials
    * Authentication cookies
    * Full environment variables
14. Escape all rendered output and metadata correctly.
15. Treat terminal output as untrusted content.
16. Protect against cross-user and cross-device data access.
17. Include an audit trail for:

    * Login
    * Device pairing
    * Device revocation
    * Repository creation
    * Action creation
    * Job start
    * Job cancellation
18. Do not expose a general unauthenticated webhook that executes commands.
19. Do not use `eval`.
20. Avoid building shell commands by string concatenation.

Create a `SECURITY.md` file explaining:

* Threat model
* Trust boundaries
* Known MVP limitations
* Responsible disclosure process
* Safe deployment recommendations

# Repository registration

Implement repository registration with the following flow:

1. User selects an online device.
2. User enters:

   * Repository name
   * Absolute path
   * Optional description
3. The server sends a validation request to the agent.
4. The agent verifies:

   * The path exists
   * It is a directory
   * It is accessible
   * It is preferably a Git repository
5. The agent returns:

   * Canonical resolved path
   * Whether `.git` exists
   * Current branch when available
   * Repository root
6. The user confirms registration.
7. The server stores the canonical path.

Do not allow the server to assume that an arbitrary path exists on the laptop.

# Mobile application UX

The web interface should feel like a compact remote operations application, not a generic admin dashboard.

Create the following screens.

## Login

* Email
* Password
* Sign in
* Clear error states

## Devices

Display cards with:

* Device name
* Platform
* Online or offline state
* Last seen time
* Agent version
* Number of repositories

Actions:

* Open device
* Add device
* Revoke device

## Device details

Display:

* Device status
* Repository list
* Recent jobs
* Device metadata

## Repository screen

Display:

* Repository name
* Device name
* Path
* Current status
* Predefined actions
* Custom command entry when enabled
* Recent command history

Actions should appear as large mobile-friendly buttons.

Example:

```text
Continue with Codex
Run tests
Git status
Pull latest
Custom command
```

## Job terminal

Display:

* Job command
* Repository
* Device
* Status
* Start time
* Live terminal
* Input field or terminal keyboard input
* Cancel button
* Reconnect state
* Exit code when complete

Use xterm.js.

The terminal must:

* Work on narrow mobile screens
* Support touch scrolling
* Resize appropriately
* Avoid horizontal page overflow
* Clearly distinguish disconnected, reconnecting, and completed states

## History

Display:

* Command
* Repository
* Device
* Status
* Start time
* Duration
* Exit code

Allow opening a previous job and reading retained output.

# API design

Create a clean REST API for normal application operations and WebSockets for live device and terminal communication.

Suggested REST endpoints:

```text
POST   /api/auth/register
POST   /api/auth/login
POST   /api/auth/logout
GET    /api/auth/session

GET    /api/devices
POST   /api/devices/pairing-codes
GET    /api/devices/:deviceId
DELETE /api/devices/:deviceId

GET    /api/devices/:deviceId/repositories
POST   /api/devices/:deviceId/repositories
GET    /api/repositories/:repositoryId
PATCH  /api/repositories/:repositoryId
DELETE /api/repositories/:repositoryId

GET    /api/repositories/:repositoryId/actions
POST   /api/repositories/:repositoryId/actions
PATCH  /api/actions/:actionId
DELETE /api/actions/:actionId

POST   /api/repositories/:repositoryId/jobs
GET    /api/jobs
GET    /api/jobs/:jobId
POST   /api/jobs/:jobId/cancel
GET    /api/jobs/:jobId/output
```

Suggested WebSocket endpoints:

```text
/ws/agent
/ws/client
```

Alternatively, use a single WebSocket endpoint with role-specific authentication.

# Protocol messages

Create a versioned protocol package.

Every message should contain fields similar to:

```json
{
  "version": 1,
  "type": "job.start",
  "requestId": "uuid",
  "timestamp": "ISO-8601 timestamp",
  "payload": {}
}
```

Implement at least these message types:

## Agent to server

```text
agent.hello
agent.heartbeat
agent.status
repository.validation.result
job.accepted
job.started
job.output
job.status
job.completed
job.failed
job.cancelled
job.input.acknowledged
job.buffer.sync
```

## Server to agent

```text
agent.welcome
repository.validate
job.start
job.input
job.resize
job.cancel
job.buffer.request
```

## Server to web client

```text
device.status
job.status
job.output
job.completed
job.failed
```

## Web client to server

```text
job.subscribe
job.unsubscribe
job.input
job.resize
job.cancel
```

Use discriminated unions and exhaustive handling.

# Job dispatch rules

When a job is created:

1. Validate user ownership.
2. Validate device ownership.
3. Validate repository ownership.
4. Confirm the device is online.
5. Store the job as `queued`.
6. Dispatch it to the connected agent.
7. Require an acknowledgement.
8. Mark it as `dispatched`.
9. Mark it as `running` when the process starts.
10. Persist output sequence numbers.
11. Mark it according to the final process result.

Handle these cases:

* Device goes offline before acknowledgement
* Agent rejects the repository path
* Process executable is missing
* Process cannot start
* Agent disconnects during execution
* Browser disconnects
* Output arrives more than once
* Cancellation races with process completion

Use idempotency wherever practical.

# Command environment

By default, inherit the agent process environment but allow safe repository-level configuration of selected environment variable names.

Do not expose environment values in the web interface.

For the MVP:

* Allow a repository to define a list of permitted inherited environment-variable names.
* Do not permit users to remotely set arbitrary secrets through the UI.
* Document that secret management is outside the initial MVP.

Make sure common developer command paths work when the agent runs as a background service.

Document issues involving:

* PATH differences
* shell initialization
* Homebrew paths on macOS
* Node version managers
* Python version managers
* user-level binaries

Support configuration such as:

```json
{
  "shell": "/bin/zsh",
  "shellArgs": ["-lc"],
  "extraPath": [
    "/opt/homebrew/bin",
    "/usr/local/bin"
  ]
}
```

# Agent service installation

Provide commands and templates for running the agent persistently.

## macOS

Provide a `launchd` plist example.

## Linux

Provide a `systemd` service example.

## Windows

Provide documentation for running it as a Windows service, even if the full installer is postponed.

The agent must restart automatically after unexpected failure.

Do not require the user to remain logged into a terminal session.

# PWA requirements

Make the web application installable as a progressive web application.

Include:

* Web application manifest
* Appropriate icons or placeholders
* Mobile viewport settings
* Home-screen installation support
* Basic service worker
* A useful offline screen

Do not pretend commands can be run while the phone itself is offline. The offline screen should explain that RelayDock needs connectivity to reach the server.

# Output retention

For the MVP:

* Persist terminal output in PostgreSQL.
* Store chunks with sequence numbers.
* Apply a configurable maximum retained output size per job.
* When the limit is reached, truncate old output safely and add a system message explaining that truncation occurred.
* Set a default retention period.
* Provide an environment variable such as:

```text
JOB_RETENTION_DAYS=30
```

Add a cleanup task.

# Observability

Implement:

* Structured logs
* Request IDs
* Job IDs in relevant logs
* Device connection and disconnection logs
* Basic health endpoint
* Readiness endpoint
* Graceful shutdown
* Useful development logging

Suggested endpoints:

```text
GET /health
GET /ready
```

Do not include secrets in logs.

# Testing

Create meaningful automated tests.

## Unit tests

Cover:

* Protocol validation
* Authorization
* Repository path validation
* Command construction
* Output sequencing
* Pairing-code expiration
* Credential verification
* State transitions

## Integration tests

Cover:

* User login
* Device pairing
* Agent authentication
* Repository registration
* Job dispatch
* Output streaming
* Job completion
* Cancellation
* Reconnection and output replay
* Cross-user access rejection

## End-to-end test

Create an automated or documented end-to-end flow:

1. Start PostgreSQL and server.
2. Start the web application.
3. Register a user.
4. Pair a local agent.
5. Register a temporary repository.
6. Run a harmless command.
7. Verify streamed output.
8. Verify the exit code.
9. Reopen the job history.

Use harmless commands in tests. Do not execute destructive filesystem operations.

# Local development

Provide a one-command or nearly one-command local development experience.

Include:

```text
docker-compose.yml
.env.example
Makefile or task runner
```

Desired flow:

```bash
cp .env.example .env
docker compose up -d postgres
pnpm install
pnpm prisma:migrate
pnpm dev
```

Provide an agent development command such as:

```bash
go run ./apps/agent --server http://localhost:3000
```

or the equivalent based on the actual project structure.

# Production deployment

Provide a Docker-based deployment for:

* Server
* Web application
* PostgreSQL

Support deployment behind a reverse proxy.

Document:

* TLS requirements
* WebSocket proxying
* Required environment variables
* Database migrations
* Backup recommendations
* Device revocation
* Registration control
* Log handling

Include an example Caddy or Nginx configuration supporting secure WebSockets.

Do not deploy anything automatically to an external provider.

# Documentation

Create:

```text
README.md
SECURITY.md
CONTRIBUTING.md
docs/architecture.md
docs/protocol.md
docs/deployment.md
docs/agent-installation.md
docs/troubleshooting.md
```

The README must contain:

* What RelayDock is
* Screenshots or placeholders
* Architecture diagram
* MVP feature list
* Security warning
* Quick start
* Agent pairing
* Repository setup
* Creating an action
* Running a command
* Known limitations
* Roadmap

# Important product decisions

Use these decisions unless implementation evidence requires changing them:

1. RelayDock is self-hostable.
2. The server is a relay, authentication authority, and persistence layer.
3. Agents make outbound connections only.
4. A mobile web application is sufficient for the MVP.
5. Predefined actions are the preferred command mechanism.
6. Arbitrary custom commands are disabled by default.
7. Long-running interactive processes must survive mobile disconnection.
8. Server-side authorization is mandatory for every operation.
9. Repository paths are validated by the laptop agent.
10. The architecture must support multiple devices and multiple repositories per user.
11. The MVP may initially support one active viewer per interactive terminal, but the design should not prevent multiple viewers later.
12. The agent should not require administrator privileges.
13. Commands run under the same operating-system account as the agent.
14. Commands must not silently run with elevated privileges.
15. RelayDock is not a remote desktop product.

# Explicit non-goals for the MVP

Do not spend time implementing:

* Native iOS application
* Native Android application
* Remote desktop
* Mouse or keyboard control outside the terminal
* File browser
* Source-code editor
* Git hosting
* Full CI/CD platform
* Team organizations
* Role-based enterprise permissions
* Billing
* Public command webhooks
* Kubernetes support
* Browser-based SSH
* End-to-end encrypted terminal payloads where the server cannot inspect data
* Automatic cloud deployment
* Plugin marketplace
* Voice commands

Design the system so some of these can be added later, but do not implement them now.

# Suggested implementation phases

Work incrementally and keep the application runnable after each phase.

## Phase 1: Foundation

* Initialize monorepo.
* Configure TypeScript.
* Configure linting and formatting.
* Add PostgreSQL and Prisma.
* Add server health endpoints.
* Add React application shell.
* Add protocol package.
* Add environment validation.

## Phase 2: Authentication

* Add users.
* Add registration control.
* Add login and logout.
* Add secure sessions.
* Add protected routes.
* Add authorization helpers.
* Add authentication tests.

## Phase 3: Device pairing and connectivity

* Add pairing-code model.
* Add pairing API.
* Implement agent CLI.
* Exchange pairing code for device credential.
* Add authenticated agent WebSocket.
* Add heartbeat and device online state.
* Add device list UI.

## Phase 4: Repository management

* Add repository model.
* Add repository-validation protocol.
* Validate paths through the agent.
* Add repository management UI.
* Add predefined actions.

## Phase 5: Job execution

* Add job model.
* Dispatch non-interactive commands.
* Stream stdout and stderr.
* Store output.
* Display live output.
* Add history.

## Phase 6: Interactive terminal

* Add PTY execution.
* Add xterm.js.
* Add stdin.
* Add resize events.
* Add cancellation.
* Add mobile terminal improvements.

## Phase 7: Persistence and reconnection

* Keep jobs alive after browser disconnect.
* Add output sequencing.
* Add output replay.
* Add agent reconnect behavior.
* Add bounded buffering.
* Add state reconciliation.

## Phase 8: Hardening

* Add rate limits.
* Add message-size limits.
* Add audit events.
* Add output retention.
* Add credential revocation.
* Add security documentation.
* Add cross-user authorization tests.

## Phase 9: Packaging

* Add Docker images.
* Add Docker Compose.
* Add macOS launchd configuration.
* Add Linux systemd configuration.
* Add release build commands.
* Complete documentation.

# Definition of done

The MVP is complete when this exact scenario works:

1. I start the RelayDock server and web application.
2. I register and sign in from a browser.
3. I generate a device-pairing code.
4. I run the RelayDock agent on my laptop.
5. The agent pairs successfully.
6. The laptop appears online in the web application.
7. I register an existing local Git repository.
8. The agent validates its path.
9. I add a predefined action called “Continue with Codex.”
10. The action starts `codex` in the selected repository.
11. An interactive terminal opens in the web application.
12. I can see output in real time.
13. I can enter text into the running process.
14. I can close the browser.
15. The process remains alive.
16. I can reopen the web application.
17. I can reconnect to the same job.
18. I can see output produced while I was disconnected.
19. I can cancel the process.
20. The job history records its final state.
21. Another user cannot access my devices, repositories, jobs, or output.
22. Revoking the laptop immediately prevents the agent from reconnecting.

# Engineering quality requirements

* Use strict TypeScript.
* Do not use `any` without a documented justification.
* Use clear module boundaries.
* Keep protocol schemas centralized.
* Validate external input.
* Handle errors explicitly.
* Avoid silent failures.
* Use database transactions where consistency requires them.
* Add comments only where they explain non-obvious decisions.
* Prefer readable code over clever abstractions.
* Do not generate placeholder functions that pretend to work.
* Do not mark incomplete functionality as complete.
* Do not weaken security merely to make a demo pass.
* Keep a running implementation checklist in `docs/progress.md`.
* Record material architectural decisions in `docs/decisions/` as ADRs.

# Instructions for working autonomously

Begin by inspecting the existing repository.

If it is empty, initialize the project from scratch.

Before coding:

1. Summarize the current repository state.
2. Identify available tooling and constraints.
3. Write a concise implementation plan into `docs/progress.md`.
4. Select the first vertical slice that produces a working end-to-end path.

Then implement the project continuously.

Do not stop after producing an architecture document or scaffolding.

Prioritize a working vertical slice:

```text
Pair agent → register repository → run command → stream output
```

After the non-interactive vertical slice works, add PTY interaction and reconnection.

Run tests and type checks frequently.

After each major phase:

* Update `docs/progress.md`.
* Run the relevant tests.
* Fix errors before proceeding.
* Commit changes when Git is available, using clear conventional commit messages.

When you encounter an ambiguity, make the most secure and maintainable reasonable decision, document it, and continue rather than waiting for clarification.

At the end, provide:

1. A summary of what was implemented.
2. The architecture used.
3. Exact local setup commands.
4. Exact agent-pairing commands.
5. Exact commands for running the tests.
6. Known limitations.
7. Security considerations.
8. The next five recommended improvements.

Start working now. Continue until the end-to-end MVP is genuinely operational or until a concrete external constraint prevents further progress.

For the repository and command-line names, use:

```text
Project: RelayDock
Repository: relaydock
Agent binary: relaydock-agent
Server binary/service: relaydock-server
Default configuration directory: ~/.config/relaydock
Environment-variable prefix: RELAYDOCK_
```

A strong one-line description for the README is:

> **RelayDock lets you securely run and supervise development commands on your own computers from any browser, without exposing those computers to the internet.**
