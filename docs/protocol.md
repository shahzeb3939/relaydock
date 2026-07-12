# Protocol

RelayDock protocol version 1 uses JSON over WebSockets. The canonical TypeScript schemas live in `packages/protocol`; the Go agent mirrors the same discriminated messages.

Every envelope contains:

```json
{
  "version": 1,
  "type": "job.output",
  "requestId": "36-character UUID",
  "timestamp": "2026-07-12T12:00:00.000Z",
  "payload": {}
}
```

Messages with unknown versions, types, invalid UUIDs, invalid timestamps, or payloads over declared limits are rejected. The initial maximum encoded WebSocket message is 256 KiB; an individual output chunk is at most 64 KiB and a command at most 16 KiB.

## Agent to server

| Type                           | Purpose                                                                       |
| ------------------------------ | ----------------------------------------------------------------------------- |
| `agent.hello`                  | Advertise device identity, agent version, protocol support, and running jobs. |
| `agent.heartbeat`              | Refresh presence.                                                             |
| `agent.status`                 | Report an agent status detail.                                                |
| `repository.validation.result` | Return canonical path, repository root, Git state, branch, or error.          |
| `job.accepted`                 | Acknowledge an authorized start request.                                      |
| `job.started`                  | Report the local process start and optional PID.                              |
| `job.output`                   | Deliver one sequence-numbered stdout, stderr, or system chunk.                |
| `job.status`                   | Report an intermediate state.                                                 |
| `job.completed`                | Report normal process exit and code.                                          |
| `job.failed`                   | Report a start or execution failure.                                          |
| `job.cancelled`                | Confirm cancellation.                                                         |
| `job.input.acknowledged`       | Acknowledge interactive input sequence.                                       |
| `job.buffer.sync`              | Replay a bounded set of chunks after reconnect.                               |

## Server to agent

`agent.welcome`, `repository.validate`, `job.start`, `job.input`, `job.resize`, `job.cancel`, and `job.buffer.request` carry server-authorized instructions. A `job.start` includes the registered repository ID and path, relative working directory, shell configuration, selected inherited environment variable names, and initial terminal dimensions.

## Web client and server

The client sends `job.subscribe`, `job.unsubscribe`, `job.input`, `job.resize`, and `job.cancel`. Subscription includes the last rendered sequence (or `-1`), after which the server replays persisted chunks before registering the socket for live delivery.

The server publishes `device.status`, `job.status`, `job.output`, `job.completed`, and `job.failed`. Output is terminal data, not HTML; clients write it directly to xterm.js without HTML interpretation.

## Sequencing and idempotency

The agent assigns sequence `0` to the first output/system chunk for a job and increments monotonically. A server insert is idempotent by `(jobId, sequence)`. Replayed chunks use their original sequence. A client ignores a chunk whose sequence is not greater than its last rendered sequence.

Changing required fields or semantics requires a new protocol version and a compatibility window; adding an optional field may remain within version 1 when older peers safely ignore it.
