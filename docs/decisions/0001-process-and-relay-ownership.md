# ADR 0001: Process and relay ownership

- Status: Accepted
- Date: 2026-07-12

## Context

RelayDock must keep commands alive when a mobile browser disconnects, while laptops accept no inbound network traffic.

## Decision

The Go agent owns local process and PTY lifetimes. It connects outbound to a Fastify server over an authenticated WebSocket. The server owns authorization, dispatch state, audit records, and durable sequence-numbered output. Browsers use a separate authenticated WebSocket and replay persisted output before consuming live messages.

Raw device credentials are returned once, stored only by the agent, and represented server-side by an Argon2id hash. Browser authentication uses opaque, database-backed sessions in HttpOnly cookies rather than browser-readable bearer tokens.

## Consequences

- Browser disconnects cannot terminate local commands.
- Agent restarts do terminate direct PTY sessions in the MVP; disk-backed or tmux recovery is a future option.
- The server can inspect terminal content and must be treated as a trusted component.
- Idempotent `(jobId, sequence)` storage permits safe agent output replay.
