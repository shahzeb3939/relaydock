# Agent installation

## One-command installation

In RelayDock, choose **Add device**, generate a pairing code, and copy the command shown in the modal. On macOS or Linux it has this form:

```bash
curl -fsSL https://relay.example.com/install-agent.sh | sh -s -- \
  --server https://relay.example.com \
  --code ABCD-EFGH \
  --name "MacBook Pro"
```

No repository checkout, Go installation, package manager, or administrator access is required. The bootstrap supports Intel and Apple silicon macOS and amd64 and arm64 Linux. It:

1. refuses to run as root and requires HTTPS except for loopback development servers;
2. detects the operating system and architecture;
3. downloads the pinned agent and `SHA256SUMS` from the same RelayDock origin;
4. verifies the archive checksum and the executable's reported version;
5. pairs only if this operating-system user has no existing RelayDock configuration;
6. installs `~/.local/bin/relaydock-agent` and starts a user-level launchd or systemd service.

The raw device credential is stored at `~/.config/relaydock/agent.json` with mode `0600`. Keep that file private and never sync or commit it. Re-running the install command against the same server updates the executable and service while preserving that file and the device identity byte-for-byte; the supplied pairing code and name are ignored in that case.

Pairing is required again only if the device is revoked, the configuration is removed, the server's credential pepper is intentionally rotated, or the operating-system account is replaced. An existing identity is never silently moved to a different server.

The laptop must be powered on, connected to the internet, and signed in to the operating-system account that installed RelayDock. Closing the terminal does not stop the background service.

## Service status and logs

On macOS, the installer creates `~/Library/LaunchAgents/com.relaydock.agent.plist`. It starts at login and launchd restarts it after a failure. Inspect it with:

```bash
launchctl print "gui/$(id -u)/com.relaydock.agent"
tail -f "$HOME/Library/Logs/RelayDock/agent.log"
```

On Linux, the installer creates `~/.config/systemd/user/relaydock-agent.service`. It starts when the user manager starts and systemd restarts it after a failure. Inspect it with:

```bash
systemctl --user status relaydock-agent.service
journalctl --user -u relaydock-agent.service -f
```

Most desktop distributions start user services after login. To keep the service running after logout and allow it to start at boot before an interactive login, enable lingering once if your distribution permits it:

```bash
loginctl enable-linger "$USER"
```

Linger is optional and is not enabled by the RelayDock installer because host policy may require administrator approval.

## Environment and PATH

Background services do not load the same interactive shell startup files as a terminal. Configure repositories with an explicit shell and `extraPath` entries such as `/opt/homebrew/bin`, `/usr/local/bin`, or user-level language-manager shims. Only names in a repository's inherited-environment allowlist are copied. RelayDock never displays environment values remotely.

Homebrew, `nvm`, `fnm`, `pyenv`, and similar tools often require login-shell initialization. Prefer stable absolute executable paths for predefined actions, or use `/bin/zsh -lc` only when shell behavior is actually required.

## Build from source

For agent development, Go 1.23 or newer can build and run the CLI directly:

```bash
cd apps/agent
go build -o relaydock-agent .
./relaydock-agent install \
  --server https://relay.example.com \
  --code ABCD-EFGH \
  --name "MacBook Pro"
```

The `pair` and foreground `run` commands remain available for debugging. Do not add `--force` to normal pairing; replacing a credential creates a different device identity.

Release maintainers can regenerate the four versioned macOS/Linux distributions and checksums with:

```sh
pnpm build:agent:distributions
pnpm test:agent:bootstrap
```

Distribution builds use the Go version declared by the project, disable CGO, strip local paths and VCS metadata, and use timestamp-free gzip output. CI regenerates them and rejects checksum drift.

## Windows

The one-command installer currently supports macOS and Linux. Windows non-interactive execution is supported, but until the project provides a signed service wrapper and ConPTY backend, build the Windows agent from source and use Task Scheduler or a maintained service wrapper to launch `relaydock-agent.exe run` as a dedicated non-administrator user at logon/startup. Restrict the config ACL to that user. Interactive terminal parity is a documented roadmap item.
