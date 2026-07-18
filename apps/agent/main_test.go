package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestResolveInstallConfigPathLeavesDefaultEmpty guards the regression where
// runInstall pre-resolved the path to the legacy default, which defeated per-server
// namespacing (the installer keys namespacing off an empty ConfigPath).
func TestResolveInstallConfigPathLeavesDefaultEmpty(t *testing.T) {
	t.Setenv("RELAYDOCK_CONFIG", "")

	path, err := resolveInstallConfigPath("")
	if err != nil {
		t.Fatal(err)
	}
	if path != "" {
		t.Fatalf("resolveInstallConfigPath(\"\") = %q, want empty so the installer namespaces by server", path)
	}

	explicit := filepath.Join(t.TempDir(), "custom.json")
	path, err = resolveInstallConfigPath(explicit)
	if err != nil {
		t.Fatal(err)
	}
	if path != explicit {
		t.Fatalf("explicit --config = %q, want %q", path, explicit)
	}
}

func TestResolveInstallConfigPathHonorsEnvironmentOverride(t *testing.T) {
	override := filepath.Join(t.TempDir(), "env.json")
	t.Setenv("RELAYDOCK_CONFIG", override)

	path, err := resolveInstallConfigPath("")
	if err != nil {
		t.Fatal(err)
	}
	if path != override {
		t.Fatalf("resolveInstallConfigPath honored env = %q, want %q", path, override)
	}
}

func TestResolveConfigPathPrefersLegacyThenUniqueNamespaced(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("RELAYDOCK_CONFIG", "")

	// With nothing configured, run/pair fall back to the legacy path so the caller can
	// surface the familiar "not paired" guidance.
	legacy := filepath.Join(home, ".config", "relaydock", "agent.json")
	path, err := resolveConfigPath("")
	if err != nil {
		t.Fatal(err)
	}
	if path != legacy {
		t.Fatalf("empty config with nothing paired = %q, want legacy %q", path, legacy)
	}

	// A single namespaced agent is selected automatically.
	agentsDir := filepath.Join(home, ".config", "relaydock", "agents")
	only := filepath.Join(agentsDir, "relay-example-com-abc1234567.json")
	writeFile(t, only)
	path, err = resolveConfigPath("")
	if err != nil {
		t.Fatal(err)
	}
	if path != only {
		t.Fatalf("single namespaced agent = %q, want %q", path, only)
	}

	// A second namespaced agent makes a bare run/pair ambiguous: it must error and
	// list the choices rather than silently pick one.
	second := filepath.Join(agentsDir, "relay-example-org-def7654321.json")
	writeFile(t, second)
	_, err = resolveConfigPath("")
	if err == nil || !strings.Contains(err.Error(), "multiple agents are configured") {
		t.Fatalf("ambiguous resolution error = %v", err)
	}
	if !strings.Contains(err.Error(), only) || !strings.Contains(err.Error(), second) {
		t.Fatalf("ambiguous error does not list both agents: %v", err)
	}
}

func TestResolvePairConfigPathNamespacesByServer(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("RELAYDOCK_CONFIG", "")

	// pair with no --config targets the namespaced path for its own --server, so a
	// forced re-pair of server B can never resolve to (and overwrite) server A's agent.
	pathA, err := resolvePairConfigPath("", "https://a.example.com")
	if err != nil {
		t.Fatal(err)
	}
	pathB, err := resolvePairConfigPath("", "https://b.example.com")
	if err != nil {
		t.Fatal(err)
	}
	if pathA == pathB {
		t.Fatalf("pair resolved two servers to the same path %q", pathA)
	}
	agentsDir := filepath.Join(home, ".config", "relaydock", "agents")
	for _, path := range []string{pathA, pathB} {
		if filepath.Dir(path) != agentsDir {
			t.Fatalf("pair path %q is not under the namespaced agents dir %q", path, agentsDir)
		}
	}

	// An explicit --config still wins.
	explicit := filepath.Join(t.TempDir(), "custom.json")
	path, err := resolvePairConfigPath(explicit, "https://a.example.com")
	if err != nil {
		t.Fatal(err)
	}
	if path != explicit {
		t.Fatalf("explicit --config = %q, want %q", path, explicit)
	}
}

func writeFile(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
}
