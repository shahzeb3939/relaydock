# RelayDock agent

`relaydock-agent` is the outbound-only laptop process for RelayDock. It pairs
over REST, authenticates to `/ws/agent` with the one-time-issued device
credential, validates local repository roots, and owns command and PTY process
lifetimes.

## Build and run

Go 1.23 or newer is required.

```sh
cd apps/agent
make build
./bin/relaydock-agent pair \
  --server http://localhost:3000 \
  --code ABCD-EFGH \
  --name "My laptop"
./bin/relaydock-agent
```

`relaydock-agent run` and invoking the binary without a subcommand are
equivalent. Use `--config /absolute/path/agent.json` or set
`RELAYDOCK_CONFIG` to override the default
`~/.config/relaydock/agent.json` location.

Pairing refuses to replace existing credentials unless `--force` is supplied.
The configuration directory is created with mode `0700` and the credential
file with mode `0600` on Unix. The agent also refuses to load a symlink or a
configuration file readable by group or other users.

Use HTTPS/WSS outside local development. The raw credential grants the server
the ability to dispatch commands to this operating-system account; protect the
configuration file and revoke the device in RelayDock if it may be exposed.

## Execution boundaries

- A successful `repository.validate` request records the canonical local root
  against the server-created repository UUID and persists that registry.
- `job.start` must contain both the registered UUID and the same canonical
  path. Working directories are canonicalized and rejected if lexical
  traversal or a symlink leaves that root.
- Commands are executed as `shell`, each `shellArgs` item, and the command as
  separate process arguments. RelayDock does not add `sudo` or interpolate a
  command into another command string.
- Only environment names both requested by the server and allowed in the local
  `allowedEnvironment` configuration are inherited. `extraPath` entries are
  prepended locally without exposing their values to the server.
- Interactive jobs use a directly managed Unix PTY and remain alive across
  WebSocket and browser disconnects. Input sequence numbers are idempotently
  acknowledged; resize and cancellation messages target the existing session.

## Reconnection and buffering

Reconnect delay starts at one second, doubles to 30 seconds, and applies
20 percent jitter. Heartbeats use the interval in `agent.welcome`.

Each retained job has a bounded in-memory replay buffer of at most 1,000 chunks
and 4 MiB. Output chunks have monotonically increasing sequence numbers. On
reconnection the agent resends retained chunks plus current or terminal job
state; server-side `(jobId, sequence)` idempotency removes duplicates. Up to
100 recent jobs are kept in the agent process. There is no disk-backed output
or session recovery in the MVP.

## Service examples

The files in `examples/` are templates. Replace executable paths, user names,
and labels before installation. The agent runs with the permissions and
environment of the configured account; service-manager `PATH` values are often
smaller than interactive-shell values, so use `extraPath` where needed.

## Tests

```sh
cd apps/agent
go test ./...
go test -race ./...
go vet ./...
make cross-build
```

## MVP limitations

- Agent restart or clean shutdown terminates processes; PTYs and output are not
  recoverable across an agent restart.
- Windows supports pairing, connectivity, repository validation, and
  noninteractive commands, but the MVP returns an explicit error for
  interactive PTY jobs. A ConPTY backend is still required.
- Repository registrations are trusted when requested by the authenticated
  RelayDock server. There is not yet a second local confirmation prompt.
- Buffer limits are per job rather than one global byte budget. Completed job
  buffers are evicted after the 100-job in-process retention limit.
- Credential storage uses a permission-restricted file, not Keychain, Secret
  Service, or Windows Credential Manager.
