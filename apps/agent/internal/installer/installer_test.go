package installer

import (
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/relaydock/relaydock/apps/agent/internal/client"
	"github.com/relaydock/relaydock/apps/agent/internal/config"
)

type recordedCommand struct {
	name      string
	arguments []string
}

type recordingRunner struct {
	commands []recordedCommand
	errors   map[int]error
}

func (r *recordingRunner) Run(_ context.Context, name string, arguments ...string) error {
	index := len(r.commands)
	r.commands = append(r.commands, recordedCommand{name: name, arguments: append([]string(nil), arguments...)})
	return r.errors[index]
}

func validAgentConfig(server, name string) config.Config {
	return config.Config{
		Server:             server,
		DeviceID:           uuid.NewString(),
		Credential:         "rdc_test_credential",
		DeviceName:         name,
		Repositories:       map[string]string{uuid.NewString(): "/tmp/repository"},
		AllowedEnvironment: append([]string(nil), config.DefaultAllowedEnvironment...),
	}
}

func executableFixture(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "downloaded-relaydock-agent")
	if err := os.WriteFile(path, []byte(content), 0o700); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestInstallPairsOnceAndPreservesExistingCredential(t *testing.T) {
	home := t.TempDir()
	source := executableFixture(t, "agent-v1")
	configPath := filepath.Join(home, ".config", "relaydock", "agent.json")
	runner := &recordingRunner{}
	pairCalls := 0
	pair := func(_ context.Context, options client.PairOptions) (config.Config, error) {
		pairCalls++
		if options.Server != "https://relay.example.com" || options.Code != "FIRST-CODE" || options.Name != "First name" {
			t.Fatalf("pair options = %#v", options)
		}
		return validAgentConfig(options.Server, options.Name), nil
	}
	dependencies := dependencies{
		goos:           "linux",
		uid:            501,
		homeDirectory:  home,
		executablePath: source,
		pair:           pair,
		runner:         runner,
	}

	first, err := install(context.Background(), Options{
		Server:       "https://relay.example.com/",
		Code:         "FIRST-CODE",
		Name:         "First name",
		ConfigPath:   configPath,
		AgentVersion: "0.1.0",
	}, dependencies)
	if err != nil {
		t.Fatalf("first install: %v", err)
	}
	if first.AlreadyPaired {
		t.Fatal("first install reported an existing pairing")
	}
	if pairCalls != 1 {
		t.Fatalf("pair calls = %d, want 1", pairCalls)
	}
	configurationBefore, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	assertMode(t, configPath, 0o600)
	assertMode(t, first.BinaryPath, 0o755)
	assertMode(t, first.ServicePath, 0o644)
	assertFileContent(t, first.BinaryPath, "agent-v1")
	assertSystemdCommands(t, runner.commands[:4])

	if err := os.WriteFile(source, []byte("agent-v2"), 0o700); err != nil {
		t.Fatal(err)
	}
	second, err := install(context.Background(), Options{
		Server:       "https://relay.example.com",
		Code:         "UNUSED-CODE",
		Name:         "Ignored replacement name",
		ConfigPath:   configPath,
		AgentVersion: "0.2.0",
	}, dependencies)
	if err != nil {
		t.Fatalf("second install: %v", err)
	}
	if !second.AlreadyPaired {
		t.Fatal("second install did not report the existing pairing")
	}
	if second.DeviceName != "First name" {
		t.Fatalf("device name = %q, want preserved name", second.DeviceName)
	}
	if pairCalls != 1 {
		t.Fatalf("pair calls after reinstall = %d, want 1", pairCalls)
	}
	configurationAfter, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(configurationAfter, configurationBefore) {
		t.Fatal("idempotent install changed the existing agent configuration")
	}
	assertFileContent(t, second.BinaryPath, "agent-v2")
	assertSystemdCommands(t, runner.commands[4:])
}

func TestInstallRefusesServerMismatchWithoutChangingConfiguration(t *testing.T) {
	home := t.TempDir()
	configPath := filepath.Join(home, ".config", "relaydock", "agent.json")
	if err := config.Save(configPath, validAgentConfig("https://first.example.com", "Existing")); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	runner := &recordingRunner{}
	_, err = install(context.Background(), Options{
		Server:     "https://second.example.com",
		Code:       "NEW-CODE",
		Name:       "Replacement",
		ConfigPath: configPath,
	}, dependencies{
		goos:           "darwin",
		uid:            501,
		homeDirectory:  home,
		executablePath: executableFixture(t, "agent"),
		pair: func(context.Context, client.PairOptions) (config.Config, error) {
			t.Fatal("pair was called for an existing configuration")
			return config.Config{}, nil
		},
		runner: runner,
	})
	if err == nil || !strings.Contains(err.Error(), "already paired with https://first.example.com") {
		t.Fatalf("install error = %v", err)
	}
	after, readErr := os.ReadFile(configPath)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if !reflect.DeepEqual(after, before) {
		t.Fatal("server mismatch changed the existing configuration")
	}
	if len(runner.commands) != 0 {
		t.Fatalf("service commands ran after mismatch: %#v", runner.commands)
	}
	if _, statErr := os.Stat(filepath.Join(home, ".local", "bin", "relaydock-agent")); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("binary was installed after mismatch: %v", statErr)
	}
}

func TestInstallRejectsInsecureExistingConfiguration(t *testing.T) {
	if os.PathSeparator == '\\' {
		t.Skip("Unix permission test")
	}
	home := t.TempDir()
	configPath := filepath.Join(home, ".config", "relaydock", "agent.json")
	if err := config.Save(configPath, validAgentConfig("https://relay.example.com", "Existing")); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(configPath, 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := install(context.Background(), Options{
		Server:     "https://relay.example.com",
		ConfigPath: configPath,
	}, dependencies{
		goos:           "linux",
		uid:            501,
		homeDirectory:  home,
		executablePath: executableFixture(t, "agent"),
		pair: func(context.Context, client.PairOptions) (config.Config, error) {
			t.Fatal("pair was called for an insecure existing configuration")
			return config.Config{}, nil
		},
		runner: &recordingRunner{},
	})
	if err == nil || !strings.Contains(err.Error(), "permissions must be 0600 or stricter") {
		t.Fatalf("install error = %v", err)
	}
}

func TestInstallRefusesRootAndUnsupportedPlatforms(t *testing.T) {
	base := dependencies{
		goos:           "linux",
		uid:            0,
		homeDirectory:  t.TempDir(),
		executablePath: executableFixture(t, "agent"),
		pair:           func(context.Context, client.PairOptions) (config.Config, error) { return config.Config{}, nil },
		runner:         &recordingRunner{},
	}
	if _, err := install(context.Background(), Options{Server: "https://relay.example.com"}, base); err == nil || !strings.Contains(err.Error(), "refusing to install RelayDock as root") {
		t.Fatalf("root install error = %v", err)
	}
	base.goos = "windows"
	base.uid = -1
	if _, err := install(context.Background(), Options{Server: "https://relay.example.com"}, base); err == nil || !strings.Contains(err.Error(), "not supported on windows") {
		t.Fatalf("Windows install error = %v", err)
	}
}

func TestInstallLaunchAgentWritesManifestAndRunsExpectedCommands(t *testing.T) {
	home := t.TempDir()
	configPath := filepath.Join(home, ".config", "relaydock", "agent.json")
	if err := config.Save(configPath, validAgentConfig("https://relay.example.com", "Mac")); err != nil {
		t.Fatal(err)
	}
	runner := &recordingRunner{errors: map[int]error{0: errors.New("service not loaded")}}
	result, err := install(context.Background(), Options{
		Server:     "https://relay.example.com",
		ConfigPath: configPath,
	}, dependencies{
		goos:           "darwin",
		uid:            501,
		homeDirectory:  home,
		executablePath: executableFixture(t, "agent"),
		pair: func(context.Context, client.PairOptions) (config.Config, error) {
			t.Fatal("pair was called for an existing Mac configuration")
			return config.Config{}, nil
		},
		runner: runner,
	})
	if err != nil {
		t.Fatal(err)
	}
	wantCommands := []recordedCommand{
		{name: "launchctl", arguments: []string{"bootout", "gui/501/com.relaydock.agent"}},
		{name: "launchctl", arguments: []string{"enable", "gui/501/com.relaydock.agent"}},
		{name: "launchctl", arguments: []string{"bootstrap", "gui/501", result.ServicePath}},
		{name: "launchctl", arguments: []string{"kickstart", "-k", "gui/501/com.relaydock.agent"}},
		{name: "launchctl", arguments: []string{"print", "gui/501/com.relaydock.agent"}},
	}
	if !reflect.DeepEqual(runner.commands, wantCommands) {
		t.Fatalf("launchctl commands = %#v, want %#v", runner.commands, wantCommands)
	}
	assertMode(t, result.ServicePath, 0o644)
	assertMode(t, filepath.Join(home, "Library", "Logs", "RelayDock"), 0o700)
	manifest, err := os.ReadFile(result.ServicePath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(manifest), result.BinaryPath) || !strings.Contains(string(manifest), configPath) {
		t.Fatalf("launch agent does not contain installed paths:\n%s", manifest)
	}
}

func TestRenderLaunchAgentEscapesPathsAndProducesXML(t *testing.T) {
	manifest, err := renderLaunchAgent(
		`/Users/A & B/"agent"`,
		`/Users/A & B/config's.json`,
		`/Users/A & B/<agent>.log`,
	)
	if err != nil {
		t.Fatal(err)
	}
	text := string(manifest)
	for _, escaped := range []string{"A &amp; B", "&quot;agent&quot;", "config&apos;s.json", "&lt;agent&gt;.log"} {
		if !strings.Contains(text, escaped) {
			t.Fatalf("manifest does not contain %q:\n%s", escaped, text)
		}
	}
	decoder := xml.NewDecoder(strings.NewReader(text))
	for {
		if _, err := decoder.Token(); errors.Is(err, io.EOF) {
			break
		} else if err != nil {
			t.Fatalf("decode launch agent XML: %v", err)
		}
	}
	if runtime.GOOS == "darwin" {
		command := exec.Command("plutil", "-lint", "-")
		command.Stdin = strings.NewReader(text)
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("plutil rejected generated launch agent: %v: %s", err, output)
		}
	}
}

func TestRenderSystemdUserServiceEscapesPaths(t *testing.T) {
	quoted, err := quoteSystemdArgument(`/home/Test 100%/$HOME/"agent"\bin`)
	if err != nil {
		t.Fatal(err)
	}
	if quoted != `"/home/Test 100%%/$$HOME/\"agent\"\\bin"` {
		t.Fatalf("quoted argument = %s", quoted)
	}
	unit, err := renderSystemdUserService(`/home/Test 100%/agent`, `/home/Test 100%/agent.json`)
	if err != nil {
		t.Fatal(err)
	}
	text := string(unit)
	for _, expected := range []string{
		`ExecStart="/home/Test 100%%/agent" run --config "/home/Test 100%%/agent.json"`,
		"Restart=always",
		"UMask=0077",
		"WantedBy=default.target",
	} {
		if !strings.Contains(text, expected) {
			t.Fatalf("systemd unit does not contain %q:\n%s", expected, text)
		}
	}
	if strings.Contains(text, "User=") || strings.Contains(text, "multi-user.target") {
		t.Fatalf("systemd user unit contains system-service directives:\n%s", text)
	}
	if _, err := quoteSystemdArgument("relative/path"); err == nil {
		t.Fatal("relative systemd path was accepted")
	}
	if _, err := quoteSystemdArgument("/home/test/line\nbreak"); err == nil {
		t.Fatal("newline in systemd path was accepted")
	}
}

func assertSystemdCommands(t *testing.T, commands []recordedCommand) {
	t.Helper()
	want := []recordedCommand{
		{name: "systemctl", arguments: []string{"--user", "daemon-reload"}},
		{name: "systemctl", arguments: []string{"--user", "enable", "relaydock-agent.service"}},
		{name: "systemctl", arguments: []string{"--user", "restart", "relaydock-agent.service"}},
		{name: "systemctl", arguments: []string{"--user", "is-active", "--quiet", "relaydock-agent.service"}},
	}
	if !reflect.DeepEqual(commands, want) {
		t.Fatalf("systemctl commands = %#v, want %#v", commands, want)
	}
}

func assertMode(t *testing.T, path string, want os.FileMode) {
	t.Helper()
	if os.PathSeparator == '\\' {
		return
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != want {
		t.Fatalf("%s mode = %04o, want %04o", path, info.Mode().Perm(), want)
	}
}

func assertFileContent(t *testing.T, path, want string) {
	t.Helper()
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != want {
		t.Fatalf("%s content = %q, want %q", path, content, want)
	}
}

func TestInstallStopsWhenServiceCommandFails(t *testing.T) {
	home := t.TempDir()
	configPath := filepath.Join(home, ".config", "relaydock", "agent.json")
	if err := config.Save(configPath, validAgentConfig("https://relay.example.com", "Linux")); err != nil {
		t.Fatal(err)
	}
	runner := &recordingRunner{errors: map[int]error{1: fmt.Errorf("systemctl unavailable")}}
	_, err := install(context.Background(), Options{Server: "https://relay.example.com", ConfigPath: configPath}, dependencies{
		goos:           "linux",
		uid:            501,
		homeDirectory:  home,
		executablePath: executableFixture(t, "agent"),
		pair:           func(context.Context, client.PairOptions) (config.Config, error) { return config.Config{}, nil },
		runner:         runner,
	})
	if err == nil || !strings.Contains(err.Error(), "enable systemd user service") {
		t.Fatalf("service failure error = %v", err)
	}
	if len(runner.commands) != 2 {
		t.Fatalf("commands continued after failure: %#v", runner.commands)
	}
}
