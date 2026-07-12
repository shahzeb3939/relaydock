# Troubleshooting

## The agent cannot pair

- Confirm the code has not expired or already been consumed; codes live for about ten minutes.
- Use the server API URL, not a path ending in `/api`.
- For a remote deployment, verify the URL is HTTPS and the certificate chain is trusted.
- Check server logs by request ID without posting the pairing token or resulting credential.

## The device stays offline

- Run `relaydock-agent run` in the foreground and inspect its redacted log.
- Confirm the reverse proxy forwards WebSocket upgrades under `/ws/agent`.
- Check that the server clock and laptop clock are reasonably synchronized.
- A revoked device cannot reconnect; generate a new pairing code and pair again.

## Repository validation fails

- Paths are interpreted on the device, not inside the server container.
- Use an absolute path accessible to the agent's operating-system account.
- Resolve symlinks mentally: the canonical target must be a directory and becomes the security root.
- Background agents may have different permissions from an interactive terminal.

## A command is not found

Background services have a minimal `PATH`. Add stable directories such as `/opt/homebrew/bin` or `/usr/local/bin` to the agent/repository `extraPath`, or configure the correct login shell. Language version managers may need their shim directory or an absolute executable path.

## The terminal connects but interaction is odd

- Interactive tools require the action's `interactive` flag.
- Mobile keyboards may not expose control keys; use the terminal input controls.
- Resize the browser or reconnect to send fresh terminal dimensions.
- Windows interactive terminal support is not complete in the first release.

## Output is missing after reconnect

The browser requests persisted chunks after its last sequence. Very old output can be removed by the per-job byte cap or age retention. A system chunk marks server-side truncation. Output produced during a long server outage can also exceed the agent's bounded in-memory buffer; that limitation is explicit in job/system status.

## Readiness fails

`/health` only proves the server process is alive. `/ready` also checks PostgreSQL. Verify `DATABASE_URL`, database health, migrations, and network reachability from the server container.
