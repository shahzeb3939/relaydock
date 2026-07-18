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
	if second.ReplacedPrevious {
		t.Fatal("code-less reinstall re-paired instead of preserving the credential")
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
		Name:       "Replacement",
		ConfigPath: configPath,
	}, dependencies{
		goos:           "darwin",
		uid:            501,
		homeDirectory:  home,
		executablePath: executableFixture(t, "agent"),
		pair: func(context.Context, client.PairOptions) (config.Config, error) {
			t.Fatal("pair was called for a code-less server mismatch")
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

func TestInstallRepairsWhenCodeProvidedForExistingConfiguration(t *testing.T) {
	home := t.TempDir()
	configPath := filepath.Join(home, ".config", "relaydock", "agent.json")
	oldConfig := validAgentConfig("https://relay.example.com", "Old device")
	oldConfig.Credential = "rdc_old_credential"
	if err := config.Save(configPath, oldConfig); err != nil {
		t.Fatal(err)
	}
	oldBytes, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}

	runner := &recordingRunner{}
	pairCalls := 0
	newDeviceID := uuid.NewString()
	pair := func(_ context.Context, options client.PairOptions) (config.Config, error) {
		pairCalls++
		if options.Server != "https://relay.example.com" || options.Code != "NEW-CODE" || options.Name != "New name" {
			t.Fatalf("pair options = %#v", options)
		}
		return config.Config{
			Server:             options.Server,
			DeviceID:           newDeviceID,
			Credential:         "rdc_new_credential",
			DeviceName:         options.Name,
			Repositories:       map[string]string{},
			AllowedEnvironment: append([]string(nil), config.DefaultAllowedEnvironment...),
		}, nil
	}
	result, err := install(context.Background(), Options{
		Server:       "https://relay.example.com",
		Code:         "NEW-CODE",
		Name:         "New name",
		ConfigPath:   configPath,
		AgentVersion: "0.1.0",
	}, dependencies{
		goos:           "linux",
		uid:            501,
		homeDirectory:  home,
		executablePath: executableFixture(t, "agent-repair"),
		pair:           pair,
		runner:         runner,
	})
	if err != nil {
		t.Fatalf("re-pair install: %v", err)
	}
	if pairCalls != 1 {
		t.Fatalf("pair calls = %d, want 1", pairCalls)
	}
	if result.AlreadyPaired {
		t.Fatal("re-pair reported an existing pairing was preserved")
	}
	if !result.ReplacedPrevious {
		t.Fatal("re-pair did not report replacing the previous credential")
	}
	backupPath := configPath + ".previous"
	if result.BackupPath != backupPath {
		t.Fatalf("backup path = %q, want %q", result.BackupPath, backupPath)
	}

	reloaded, err := config.Load(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if reloaded.Credential != "rdc_new_credential" || reloaded.DeviceID != newDeviceID || reloaded.DeviceName != "New name" {
		t.Fatalf("reloaded config = %#v, want the freshly paired credential", reloaded)
	}
	backupBytes, err := os.ReadFile(backupPath)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(backupBytes, oldBytes) {
		t.Fatal("backup does not preserve the previous configuration verbatim")
	}
	assertMode(t, backupPath, 0o600)
	assertMode(t, configPath, 0o600)
	assertFileContent(t, result.BinaryPath, "agent-repair")
	assertSystemdCommands(t, runner.commands)
}

func TestInstallRepairFailureKeepsExistingConfiguration(t *testing.T) {
	home := t.TempDir()
	configPath := filepath.Join(home, ".config", "relaydock", "agent.json")
	if err := config.Save(configPath, validAgentConfig("https://relay.example.com", "Existing")); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	runner := &recordingRunner{}
	_, err = install(context.Background(), Options{
		Server:     "https://relay.example.com",
		Code:       "BAD-CODE",
		Name:       "Replacement",
		ConfigPath: configPath,
	}, dependencies{
		goos:           "linux",
		uid:            501,
		homeDirectory:  home,
		executablePath: executableFixture(t, "agent"),
		pair: func(context.Context, client.PairOptions) (config.Config, error) {
			return config.Config{}, errors.New("pairing rejected")
		},
		runner: runner,
	})
	if err == nil || !strings.Contains(err.Error(), "pairing rejected") {
		t.Fatalf("install error = %v", err)
	}
	after, readErr := os.ReadFile(configPath)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if !reflect.DeepEqual(after, before) {
		t.Fatal("failed re-pair changed the existing configuration")
	}
	if _, statErr := os.Stat(configPath + ".previous"); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("failed re-pair left a backup file behind: %v", statErr)
	}
	if len(runner.commands) != 0 {
		t.Fatalf("service commands ran after a failed re-pair: %#v", runner.commands)
	}
	if _, statErr := os.Stat(filepath.Join(home, ".local", "bin", "relaydock-agent")); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("binary was installed after a failed re-pair: %v", statErr)
	}
}

func TestDerivedExtraPathFiltersAndDeduplicates(t *testing.T) {
	if os.PathSeparator == '\\' {
		t.Skip("Unix PATH test")
	}
	separator := string(os.PathListSeparator)
	raw := strings.Join([]string{
		"/opt/homebrew/bin",
		"relative/skip",
		"",
		"/opt/homebrew/bin",  // duplicate of the first entry
		"  /usr/local/bin  ", // surrounding whitespace is trimmed
		"/usr/local/bin/",    // cleans to /usr/local/bin, another duplicate
		"/Users/me/.local/bin",
	}, separator)
	got := derivedExtraPath(raw)
	want := []string{"/opt/homebrew/bin", "/usr/local/bin", "/Users/me/.local/bin"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("derivedExtraPath = %#v, want %#v", got, want)
	}
	if derivedExtraPath("") != nil {
		t.Fatal("empty PATH should yield a nil list")
	}
	if derivedExtraPath("relative/only"+separator+"also/relative") != nil {
		t.Fatal("a PATH with no absolute entries should yield a nil list")
	}
}

func TestInstallPersistsCommandPathOnPairAndRepair(t *testing.T) {
	if os.PathSeparator == '\\' {
		t.Skip("Unix PATH test")
	}
	separator := string(os.PathListSeparator)
	commandPath := strings.Join([]string{"/opt/homebrew/bin", "/Users/me/.local/bin"}, separator)
	want := []string{"/opt/homebrew/bin", "/Users/me/.local/bin"}

	// A fresh pairing records the PATH the installer inherited.
	freshHome := t.TempDir()
	freshConfig := filepath.Join(freshHome, ".config", "relaydock", "agent.json")
	if _, err := install(context.Background(), Options{
		Server:       "https://relay.example.com",
		Code:         "FIRST-CODE",
		Name:         "Device",
		ConfigPath:   freshConfig,
		AgentVersion: "0.1.0",
	}, dependencies{
		goos:           "linux",
		uid:            501,
		homeDirectory:  freshHome,
		executablePath: executableFixture(t, "agent"),
		commandPath:    commandPath,
		pair: func(_ context.Context, options client.PairOptions) (config.Config, error) {
			return validAgentConfig(options.Server, options.Name), nil
		},
		runner: &recordingRunner{},
	}); err != nil {
		t.Fatalf("fresh pair install: %v", err)
	}
	fresh, err := config.Load(freshConfig)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(fresh.ExtraPath, want) {
		t.Fatalf("fresh pair extraPath = %#v, want %#v", fresh.ExtraPath, want)
	}

	// Re-pairing with a code records the freshly captured PATH as well.
	repairHome := t.TempDir()
	repairConfig := filepath.Join(repairHome, ".config", "relaydock", "agent.json")
	if err := config.Save(repairConfig, validAgentConfig("https://relay.example.com", "Old")); err != nil {
		t.Fatal(err)
	}
	newDeviceID := uuid.NewString()
	if _, err := install(context.Background(), Options{
		Server:       "https://relay.example.com",
		Code:         "NEW-CODE",
		Name:         "New name",
		ConfigPath:   repairConfig,
		AgentVersion: "0.1.0",
	}, dependencies{
		goos:           "linux",
		uid:            501,
		homeDirectory:  repairHome,
		executablePath: executableFixture(t, "agent"),
		commandPath:    commandPath,
		pair: func(_ context.Context, options client.PairOptions) (config.Config, error) {
			return config.Config{
				Server:       options.Server,
				DeviceID:     newDeviceID,
				Credential:   "rdc_new_credential",
				DeviceName:   options.Name,
				Repositories: map[string]string{},
			}, nil
		},
		runner: &recordingRunner{},
	}); err != nil {
		t.Fatalf("re-pair install: %v", err)
	}
	repaired, err := config.Load(repairConfig)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(repaired.ExtraPath, want) {
		t.Fatalf("re-pair extraPath = %#v, want %#v", repaired.ExtraPath, want)
	}
}

func TestInstallHealsMissingCommandPathWithoutClobbering(t *testing.T) {
	if os.PathSeparator == '\\' {
		t.Skip("Unix PATH test")
	}
	separator := string(os.PathListSeparator)
	home := t.TempDir()
	configPath := filepath.Join(home, ".config", "relaydock", "agent.json")
	if err := config.Save(configPath, validAgentConfig("https://relay.example.com", "Device")); err != nil {
		t.Fatal(err)
	}
	refusePairing := func(context.Context, client.PairOptions) (config.Config, error) {
		t.Fatal("pair must not run for a code-less install")
		return config.Config{}, nil
	}

	// A code-less re-run heals a configuration that has no recorded PATH.
	result, err := install(context.Background(), Options{
		Server:     "https://relay.example.com",
		ConfigPath: configPath,
	}, dependencies{
		goos:           "linux",
		uid:            501,
		homeDirectory:  home,
		executablePath: executableFixture(t, "agent"),
		commandPath:    strings.Join([]string{"/opt/homebrew/bin", "/Users/me/.local/bin"}, separator),
		pair:           refusePairing,
		runner:         &recordingRunner{},
	})
	if err != nil {
		t.Fatalf("heal install: %v", err)
	}
	if !result.AlreadyPaired || result.ReplacedPrevious {
		t.Fatalf("heal should preserve the existing identity: %#v", result)
	}
	want := []string{"/opt/homebrew/bin", "/Users/me/.local/bin"}
	healed, err := config.Load(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(healed.ExtraPath, want) {
		t.Fatalf("healed extraPath = %#v, want %#v", healed.ExtraPath, want)
	}

	// A later code-less run with a different PATH must not overwrite the recorded list.
	if _, err := install(context.Background(), Options{
		Server:     "https://relay.example.com",
		ConfigPath: configPath,
	}, dependencies{
		goos:           "linux",
		uid:            501,
		homeDirectory:  home,
		executablePath: executableFixture(t, "agent"),
		commandPath:    "/different/bin",
		pair:           refusePairing,
		runner:         &recordingRunner{},
	}); err != nil {
		t.Fatalf("second heal install: %v", err)
	}
	preserved, err := config.Load(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(preserved.ExtraPath, want) {
		t.Fatalf("second run clobbered extraPath: %#v, want %#v", preserved.ExtraPath, want)
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
	slug, err := config.ServerSlug("https://relay.example.com")
	if err != nil {
		t.Fatal(err)
	}
	label := ServiceLabelPrefix + "." + slug
	target := "gui/501/" + label
	wantCommands := []recordedCommand{
		{name: "launchctl", arguments: []string{"bootout", target}},
		{name: "launchctl", arguments: []string{"enable", target}},
		{name: "launchctl", arguments: []string{"bootstrap", "gui/501", result.ServicePath}},
		{name: "launchctl", arguments: []string{"kickstart", "-k", target}},
		{name: "launchctl", arguments: []string{"print", target}},
	}
	if !reflect.DeepEqual(runner.commands, wantCommands) {
		t.Fatalf("launchctl commands = %#v, want %#v", runner.commands, wantCommands)
	}
	if !strings.HasSuffix(result.ServicePath, label+".plist") {
		t.Fatalf("service path = %q, want it to end with the slugged label", result.ServicePath)
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
	if !strings.Contains(string(manifest), "<string>"+label+"</string>") {
		t.Fatalf("launch agent does not carry the slugged label:\n%s", manifest)
	}
}

func TestRenderLaunchAgentEscapesPathsAndProducesXML(t *testing.T) {
	manifest, err := renderLaunchAgent(
		"com.relaydock.agent.relay-example-com-0123456789",
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

func TestInstallNamespacesByServerWhenNoConfigPathGiven(t *testing.T) {
	home := t.TempDir()
	server := "https://relay.example.com"
	slug, err := config.ServerSlug(server)
	if err != nil {
		t.Fatal(err)
	}
	result, err := install(context.Background(), Options{
		Server:       server,
		Code:         "CODE",
		Name:         "Device",
		AgentVersion: "0.1.0",
	}, dependencies{
		goos:           "darwin",
		uid:            501,
		homeDirectory:  home,
		executablePath: executableFixture(t, "agent"),
		pair: func(_ context.Context, options client.PairOptions) (config.Config, error) {
			return validAgentConfig(options.Server, options.Name), nil
		},
		runner: &recordingRunner{},
	})
	if err != nil {
		t.Fatalf("install: %v", err)
	}
	wantConfig := filepath.Join(home, ".config", "relaydock", "agents", slug+".json")
	if result.ConfigPath != wantConfig {
		t.Fatalf("config path = %q, want namespaced %q", result.ConfigPath, wantConfig)
	}
	if _, err := os.Stat(wantConfig); err != nil {
		t.Fatalf("namespaced config was not written: %v", err)
	}
	if legacy := filepath.Join(home, ".config", "relaydock", "agent.json"); fileExists(legacy) {
		t.Fatal("namespaced install wrote the legacy agent.json")
	}
	label := ServiceLabelPrefix + "." + slug
	if !strings.HasSuffix(result.ServicePath, label+".plist") {
		t.Fatalf("service path = %q, want the slugged label", result.ServicePath)
	}
}

func TestInstallKeepsDifferentServersIndependent(t *testing.T) {
	home := t.TempDir()
	newDeps := func() dependencies {
		return dependencies{
			goos:           "darwin",
			uid:            501,
			homeDirectory:  home,
			executablePath: executableFixture(t, "agent"),
			pair: func(_ context.Context, options client.PairOptions) (config.Config, error) {
				return validAgentConfig(options.Server, options.Name), nil
			},
			runner: &recordingRunner{},
		}
	}
	first, err := install(context.Background(), Options{Server: "https://one.example.com", Code: "C1", Name: "One", AgentVersion: "0.1.0"}, newDeps())
	if err != nil {
		t.Fatalf("first install: %v", err)
	}
	second, err := install(context.Background(), Options{Server: "https://two.example.com", Code: "C2", Name: "Two", AgentVersion: "0.1.0"}, newDeps())
	if err != nil {
		t.Fatalf("second install: %v", err)
	}
	if first.ConfigPath == second.ConfigPath {
		t.Fatalf("two servers shared a config path: %q", first.ConfigPath)
	}
	if first.ServicePath == second.ServicePath {
		t.Fatalf("two servers shared a service: %q", first.ServicePath)
	}
	// Installing the second server must not remove the first server's agent.
	for _, path := range []string{first.ConfigPath, second.ConfigPath} {
		if !fileExists(path) {
			t.Fatalf("config %q is missing after installing the other server", path)
		}
	}
}

func TestInstallAdoptsLegacyConfigForSameServer(t *testing.T) {
	home := t.TempDir()
	server := "https://relay.example.com"
	legacyPath := filepath.Join(home, ".config", "relaydock", "agent.json")
	legacyConfig := validAgentConfig(server, "Legacy device")
	legacyConfig.Credential = "rdc_legacy_credential"
	if err := config.Save(legacyPath, legacyConfig); err != nil {
		t.Fatal(err)
	}
	runner := &recordingRunner{}
	result, err := install(context.Background(), Options{
		Server:       server,
		AgentVersion: "0.1.0",
	}, dependencies{
		goos:           "darwin",
		uid:            501,
		homeDirectory:  home,
		executablePath: executableFixture(t, "agent"),
		pair: func(context.Context, client.PairOptions) (config.Config, error) {
			t.Fatal("pair must not run when adopting a legacy config for the same server")
			return config.Config{}, nil
		},
		runner: runner,
	})
	if err != nil {
		t.Fatalf("adopt install: %v", err)
	}
	if !result.AlreadyPaired {
		t.Fatal("adoption should preserve the existing pairing")
	}
	slug, err := config.ServerSlug(server)
	if err != nil {
		t.Fatal(err)
	}
	wantConfig := filepath.Join(home, ".config", "relaydock", "agents", slug+".json")
	if result.ConfigPath != wantConfig {
		t.Fatalf("config path = %q, want namespaced %q", result.ConfigPath, wantConfig)
	}
	if fileExists(legacyPath) {
		t.Fatal("legacy config was left behind after adoption")
	}
	adopted, err := config.Load(wantConfig)
	if err != nil {
		t.Fatal(err)
	}
	if adopted.Credential != "rdc_legacy_credential" {
		t.Fatalf("adopted credential = %q, want the reused legacy credential", adopted.Credential)
	}
	legacyBootout := recordedCommand{name: "launchctl", arguments: []string{"bootout", "gui/501/" + ServiceLabelPrefix}}
	if !containsCommand(runner.commands, legacyBootout) {
		t.Fatalf("legacy launchd service was not retired: %#v", runner.commands)
	}
}

func TestInstallLeavesLegacyConfigForDifferentServerUntouched(t *testing.T) {
	home := t.TempDir()
	legacyPath := filepath.Join(home, ".config", "relaydock", "agent.json")
	if err := config.Save(legacyPath, validAgentConfig("https://old.example.com", "Legacy device")); err != nil {
		t.Fatal(err)
	}
	legacyBefore, err := os.ReadFile(legacyPath)
	if err != nil {
		t.Fatal(err)
	}
	runner := &recordingRunner{}
	newServer := "https://new.example.com"
	result, err := install(context.Background(), Options{
		Server:       newServer,
		Code:         "CODE",
		Name:         "New device",
		AgentVersion: "0.1.0",
	}, dependencies{
		goos:           "darwin",
		uid:            501,
		homeDirectory:  home,
		executablePath: executableFixture(t, "agent"),
		pair: func(_ context.Context, options client.PairOptions) (config.Config, error) {
			return validAgentConfig(options.Server, options.Name), nil
		},
		runner: runner,
	})
	if err != nil {
		t.Fatalf("install: %v", err)
	}
	legacyAfter, err := os.ReadFile(legacyPath)
	if err != nil {
		t.Fatalf("legacy config disappeared: %v", err)
	}
	if !reflect.DeepEqual(legacyAfter, legacyBefore) {
		t.Fatal("installing a different server changed the legacy configuration")
	}
	slug, err := config.ServerSlug(newServer)
	if err != nil {
		t.Fatal(err)
	}
	wantConfig := filepath.Join(home, ".config", "relaydock", "agents", slug+".json")
	if result.ConfigPath != wantConfig {
		t.Fatalf("config path = %q, want namespaced %q", result.ConfigPath, wantConfig)
	}
	legacyBootout := recordedCommand{name: "launchctl", arguments: []string{"bootout", "gui/501/" + ServiceLabelPrefix}}
	if containsCommand(runner.commands, legacyBootout) {
		t.Fatal("legacy service was retired when installing a different server")
	}
}

func TestInstallRetiresOrphanedLegacyOnRetry(t *testing.T) {
	home := t.TempDir()
	server := "https://relay.example.com"
	slug, err := config.ServerSlug(server)
	if err != nil {
		t.Fatal(err)
	}
	legacyPath := filepath.Join(home, ".config", "relaydock", "agent.json")
	namespacedPath := filepath.Join(home, ".config", "relaydock", "agents", slug+".json")
	// Reproduce the aftermath of a prior install that copied the legacy config but
	// failed before retiring the legacy service: BOTH the legacy config (same server)
	// and its namespaced copy exist.
	seed := validAgentConfig(server, "Device")
	if err := config.Save(legacyPath, seed); err != nil {
		t.Fatal(err)
	}
	if err := config.SaveNew(namespacedPath, seed); err != nil {
		t.Fatal(err)
	}
	runner := &recordingRunner{}
	result, err := install(context.Background(), Options{
		Server:       server,
		AgentVersion: "0.1.0",
	}, dependencies{
		goos:           "darwin",
		uid:            501,
		homeDirectory:  home,
		executablePath: executableFixture(t, "agent"),
		pair: func(context.Context, client.PairOptions) (config.Config, error) {
			t.Fatal("pair must not run for an already-paired retry")
			return config.Config{}, nil
		},
		runner: runner,
	})
	if err != nil {
		t.Fatalf("retry install: %v", err)
	}
	if !result.AlreadyPaired {
		t.Fatal("retry should report the existing pairing")
	}
	if fileExists(legacyPath) {
		t.Fatal("orphaned legacy config was not retired on the retry")
	}
	legacyBootout := recordedCommand{name: "launchctl", arguments: []string{"bootout", "gui/501/" + ServiceLabelPrefix}}
	if !containsCommand(runner.commands, legacyBootout) {
		t.Fatalf("orphaned legacy service was not retired on the retry: %#v", runner.commands)
	}
}

func containsCommand(commands []recordedCommand, want recordedCommand) bool {
	for _, command := range commands {
		if reflect.DeepEqual(command, want) {
			return true
		}
	}
	return false
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func assertSystemdCommands(t *testing.T, commands []recordedCommand) {
	t.Helper()
	slug, err := config.ServerSlug("https://relay.example.com")
	if err != nil {
		t.Fatal(err)
	}
	unit := "relaydock-agent-" + slug + ".service"
	want := []recordedCommand{
		{name: "systemctl", arguments: []string{"--user", "daemon-reload"}},
		{name: "systemctl", arguments: []string{"--user", "enable", unit}},
		{name: "systemctl", arguments: []string{"--user", "restart", unit}},
		{name: "systemctl", arguments: []string{"--user", "is-active", "--quiet", unit}},
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
