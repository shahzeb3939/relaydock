# RelayDock security policy

RelayDock is privileged software: its purpose is to execute developer commands on registered computers. A compromised RelayDock account, server, agent credential, or browser session can lead to code execution as the operating-system user running the agent.

## Trust boundaries

- **Browser to server:** a database-backed HttpOnly session authenticates the user. State-changing requests require an allowed origin and CSRF proof. Browser terminal output is untrusted text and must never be inserted as HTML.
- **Agent to server:** a random device credential authenticates an outbound WebSocket. The server stores only an Argon2id-derived verifier plus a server-side pepper.
- **Server to agent:** the authenticated WebSocket is the only command channel. The agent still checks the device, registered repository ID, canonical root, and resolved working directory.
- **Agent to operating system:** commands run without elevation as the account that launched the agent. RelayDock never adds `sudo`.
- **Server and database:** the MVP server can inspect commands and output. Server and database administrators are trusted.

## Implemented controls

- Argon2id passwords and device credential verifiers
- Opaque, revocable, expiring browser sessions in HttpOnly cookies
- One-time pairing codes with short expiry and immediate consumption
- User-, device-, repository-, and job-scoped authorization checks
- Explicit custom-command opt-in and confirmation
- Agent-side canonical path and traversal checks
- Strict, versioned message schemas and bounded WebSocket messages
- Idempotent output sequences and capped retained output
- Login and API rate limits
- Audit events for security-sensitive actions
- Redacted structured logging and graceful device revocation

See [docs/progress.md](docs/progress.md) for the verification state of each control.

## Safe deployment

1. Terminate TLS at a maintained reverse proxy and allow only HTTPS/WSS from untrusted networks.
2. Set unique high-entropy session and credential peppers; never commit `.env`.
3. Create the first user, then set `RELAYDOCK_ALLOW_REGISTRATION=false`.
4. Prefer predefined actions and leave custom commands disabled unless necessary.
5. Run the agent as a non-administrator account with access only to required repositories.
6. Restrict database network access, encrypt backups, and rotate them.
7. Keep the OS, reverse proxy, Node runtime, Go agent, and dependencies patched.
8. Revoke lost devices and browser sessions promptly.
9. Review audit events and logs, but never add environment values or credentials to logging.

## Known MVP limitations

- Terminal content is not end-to-end encrypted from browser to agent.
- The permission-restricted JSON agent config is weaker than an OS keychain.
- In-memory agent buffers are lost on agent restart.
- Custom commands remain inherently equivalent to remote shell access.
- Actions currently use the repository's configured shell even when a future direct argv mode would be sufficient.
- Device revocation prevents new instructions and reconnects but cannot retract a command the agent already accepted; stop the local agent or process when immediate termination is required.
- The first release does not provide organization roles, multi-party approval, or per-command sandboxing.
- Interactive PTY support is Unix-first; Windows parity requires ConPTY work.

## Responsible disclosure

Do not open a public issue for a suspected vulnerability. Send a private report to the repository owner's security contact with:

- affected version or commit;
- reproduction steps and impact;
- relevant logs with secrets removed; and
- whether the issue is already being exploited.

Allow a reasonable remediation window before public disclosure. The maintainers will acknowledge a complete report, assess severity, and coordinate a fix and disclosure timeline.
