package installer

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"unicode/utf8"
)

const serviceLabel = "com.relaydock.agent"

type commandRunner interface {
	Run(context.Context, string, ...string) error
}

type execCommandRunner struct{}

func (execCommandRunner) Run(ctx context.Context, name string, arguments ...string) error {
	command := exec.CommandContext(ctx, name, arguments...)
	output, err := command.CombinedOutput()
	if err != nil {
		message := strings.TrimSpace(string(output))
		if message == "" {
			return fmt.Errorf("run %s: %w", name, err)
		}
		return fmt.Errorf("run %s: %w: %s", name, err, message)
	}
	return nil
}

type serviceOptions struct {
	GOOS          string
	UID           int
	HomeDirectory string
	BinaryPath    string
	ConfigPath    string
}

func installService(ctx context.Context, options serviceOptions, runner commandRunner) (string, error) {
	switch options.GOOS {
	case "darwin":
		return installLaunchAgent(ctx, options, runner)
	case "linux":
		return installSystemdUserService(ctx, options, runner)
	default:
		return "", fmt.Errorf("automatic agent service installation is not supported on %s", options.GOOS)
	}
}

func installLaunchAgent(ctx context.Context, options serviceOptions, runner commandRunner) (string, error) {
	logsDirectory := filepath.Join(options.HomeDirectory, "Library", "Logs", "RelayDock")
	if err := ensurePrivateDirectory(logsDirectory); err != nil {
		return "", fmt.Errorf("create agent log directory: %w", err)
	}
	servicePath := filepath.Join(options.HomeDirectory, "Library", "LaunchAgents", serviceLabel+".plist")
	manifest, err := renderLaunchAgent(options.BinaryPath, options.ConfigPath, filepath.Join(logsDirectory, "agent.log"))
	if err != nil {
		return "", err
	}
	if err := writeFileAtomically(servicePath, 0o644, func(destination io.Writer) error {
		_, writeErr := destination.Write(manifest)
		return writeErr
	}); err != nil {
		return "", fmt.Errorf("write launch agent: %w", err)
	}
	domain := "gui/" + strconv.Itoa(options.UID)
	target := domain + "/" + serviceLabel
	_ = runner.Run(ctx, "launchctl", "bootout", target)
	if err := runner.Run(ctx, "launchctl", "enable", target); err != nil {
		return "", fmt.Errorf("enable launch agent: %w", err)
	}
	if err := runner.Run(ctx, "launchctl", "bootstrap", domain, servicePath); err != nil {
		return "", fmt.Errorf("bootstrap launch agent: %w", err)
	}
	if err := runner.Run(ctx, "launchctl", "kickstart", "-k", target); err != nil {
		return "", fmt.Errorf("start launch agent: %w", err)
	}
	if err := runner.Run(ctx, "launchctl", "print", target); err != nil {
		return "", fmt.Errorf("verify launch agent: %w", err)
	}
	return servicePath, nil
}

func renderLaunchAgent(binaryPath, configPath, logPath string) ([]byte, error) {
	for label, value := range map[string]string{
		"agent executable": binaryPath,
		"agent config":     configPath,
		"agent log":        logPath,
	} {
		if !filepath.IsAbs(value) {
			return nil, fmt.Errorf("%s path must be absolute", label)
		}
		if !utf8.ValidString(value) {
			return nil, fmt.Errorf("%s path is not valid UTF-8", label)
		}
		if strings.IndexFunc(value, invalidXMLCharacter) >= 0 {
			return nil, fmt.Errorf("%s path contains a character that is invalid in XML", label)
		}
	}
	var manifest bytes.Buffer
	manifest.WriteString(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.relaydock.agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>`)
	writeXMLEscaped(&manifest, binaryPath)
	manifest.WriteString(`</string>
    <string>run</string>
    <string>--config</string>
    <string>`)
	writeXMLEscaped(&manifest, configPath)
	manifest.WriteString(`</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>Umask</key>
  <integer>63</integer>
  <key>StandardErrorPath</key>
  <string>`)
	writeXMLEscaped(&manifest, logPath)
	manifest.WriteString(`</string>
</dict>
</plist>
`)
	return manifest.Bytes(), nil
}

func invalidXMLCharacter(character rune) bool {
	return (character != '\t' && character != '\n' && character != '\r' && character < 0x20) ||
		character == 0xfffe || character == 0xffff
}

func writeXMLEscaped(destination *bytes.Buffer, value string) {
	for _, character := range value {
		switch character {
		case '&':
			destination.WriteString("&amp;")
		case '<':
			destination.WriteString("&lt;")
		case '>':
			destination.WriteString("&gt;")
		case '"':
			destination.WriteString("&quot;")
		case '\'':
			destination.WriteString("&apos;")
		default:
			destination.WriteRune(character)
		}
	}
}

func installSystemdUserService(ctx context.Context, options serviceOptions, runner commandRunner) (string, error) {
	servicePath := filepath.Join(options.HomeDirectory, ".config", "systemd", "user", "relaydock-agent.service")
	unit, err := renderSystemdUserService(options.BinaryPath, options.ConfigPath)
	if err != nil {
		return "", err
	}
	if err := writeFileAtomically(servicePath, 0o644, func(destination io.Writer) error {
		_, writeErr := destination.Write(unit)
		return writeErr
	}); err != nil {
		return "", fmt.Errorf("write systemd user service: %w", err)
	}
	for _, command := range []struct {
		arguments []string
		message   string
	}{
		{arguments: []string{"--user", "daemon-reload"}, message: "reload systemd user services"},
		{arguments: []string{"--user", "enable", "relaydock-agent.service"}, message: "enable systemd user service"},
		{arguments: []string{"--user", "restart", "relaydock-agent.service"}, message: "start systemd user service"},
		{arguments: []string{"--user", "is-active", "--quiet", "relaydock-agent.service"}, message: "verify systemd user service"},
	} {
		if err := runner.Run(ctx, "systemctl", command.arguments...); err != nil {
			return "", fmt.Errorf("%s: %w", command.message, err)
		}
	}
	return servicePath, nil
}

func renderSystemdUserService(binaryPath, configPath string) ([]byte, error) {
	binaryArgument, err := quoteSystemdArgument(binaryPath)
	if err != nil {
		return nil, fmt.Errorf("agent executable: %w", err)
	}
	configArgument, err := quoteSystemdArgument(configPath)
	if err != nil {
		return nil, fmt.Errorf("agent config: %w", err)
	}
	return []byte(`[Unit]
Description=RelayDock laptop agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=` + binaryArgument + ` run --config ` + configArgument + `
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
UMask=0077

[Install]
WantedBy=default.target
`), nil
}

func quoteSystemdArgument(value string) (string, error) {
	if !filepath.IsAbs(value) {
		return "", errors.New("path must be absolute")
	}
	if strings.ContainsAny(value, "\x00\r\n") {
		return "", errors.New("path contains an unsupported control character")
	}
	replacer := strings.NewReplacer(
		`\`, `\\`,
		`"`, `\"`,
		`%`, `%%`,
		`$`, `$$`,
	)
	return `"` + replacer.Replace(value) + `"`, nil
}
