# Agent installation

Build the agent on the computer that will execute commands:

```bash
cd apps/agent
go build -o relaydock-agent ./cmd/relaydock-agent
install -m 0755 relaydock-agent "$HOME/.local/bin/relaydock-agent"
```

Generate a pairing code in the web app, then run:

```bash
relaydock-agent pair --server https://relay.example.com --code ABCD-EFGH --name "MacBook Pro"
relaydock-agent run
```

The fallback config is `~/.config/relaydock/agent.json` and contains the raw device credential. The agent creates it with mode `0600`; verify permissions and never sync or commit it. Native keychain storage is planned.

## Environment and PATH

Background services do not load the same interactive shell startup files as a terminal. Configure repositories with an explicit shell and `extraPath` entries such as `/opt/homebrew/bin`, `/usr/local/bin`, or user-level language-manager shims. Only names in a repository's inherited-environment allowlist are copied. RelayDock never displays environment values remotely.

Homebrew, `nvm`, `fnm`, `pyenv`, and similar tools often require login-shell initialization. Prefer stable absolute executable paths for predefined actions, or use `/bin/zsh -lc` only when shell behavior is actually required.

## macOS launchd

Copy `apps/agent/service/com.relaydock.agent.plist.example` to `~/Library/LaunchAgents/com.relaydock.agent.plist`, replace the binary and home paths, then:

```bash
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.relaydock.agent.plist
launchctl kickstart -k "gui/$(id -u)/com.relaydock.agent"
```

Use a per-user LaunchAgent, not root, so commands have the same file access as your account.

## Linux systemd

Copy `apps/agent/service/relaydock-agent.service.example` to `~/.config/systemd/user/relaydock-agent.service`, adjust paths, then:

```bash
systemctl --user daemon-reload
systemctl --user enable --now relaydock-agent
loginctl enable-linger "$USER"
```

Linger permits the user service to start without an open terminal session. Do not install it as root.

## Windows

Non-interactive execution is supported first. Until the project provides a signed service wrapper and ConPTY backend, use Windows Task Scheduler or a maintained service wrapper to launch `relaydock-agent.exe run` as a dedicated non-administrator user at logon/startup. Restrict the config ACL to that user. Interactive terminal parity is a documented roadmap item.
