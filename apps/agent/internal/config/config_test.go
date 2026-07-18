package config

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func validConfig(root string) Config {
	return Config{
		Server:             "https://relay.example.com/base",
		DeviceID:           uuid.NewString(),
		Credential:         "test-credential",
		DeviceName:         "test laptop",
		Repositories:       map[string]string{uuid.NewString(): root},
		AllowedEnvironment: []string{"PATH", "HOME"},
		ExtraPath:          []string{filepath.Join(root, "tools", "bin")},
	}
}

func TestSaveAndLoadSecureConfig(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "agent.json")
	cfg := validConfig(t.TempDir())
	if err := Save(path, cfg); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("Stat() error = %v", err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Fatalf("config mode = %04o, want 0600", info.Mode().Perm())
	}
	loaded, err := Load(path)
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if loaded.DeviceID != cfg.DeviceID || loaded.Credential != cfg.Credential || loaded.Server != cfg.Server {
		t.Fatalf("Load() = %#v, want key fields from %#v", loaded, cfg)
	}
}

func TestSaveDoesNotChangeExistingParentPermissions(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows does not expose Unix permission bits")
	}
	parent := t.TempDir()
	if err := os.Chmod(parent, 0o755); err != nil {
		t.Fatal(err)
	}
	before, err := os.Stat(parent)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(parent, "agent.json")
	if err := Save(path, validConfig(t.TempDir())); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	after, err := os.Stat(parent)
	if err != nil {
		t.Fatal(err)
	}
	if after.Mode().Perm() != before.Mode().Perm() {
		t.Fatalf("parent mode changed from %04o to %04o", before.Mode().Perm(), after.Mode().Perm())
	}
}

func TestSaveNewRefusesToReplaceExistingConfiguration(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "agent.json")
	first := validConfig(t.TempDir())
	if err := SaveNew(path, first); err != nil {
		t.Fatalf("SaveNew() first error = %v", err)
	}
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	second := validConfig(t.TempDir())
	if err := SaveNew(path, second); !errors.Is(err, os.ErrExist) {
		t.Fatalf("SaveNew() replacement error = %v, want os.ErrExist", err)
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(after) != string(before) {
		t.Fatal("SaveNew() changed the existing configuration")
	}
	assertConfigMode(t, path, 0o600)
}

func assertConfigMode(t *testing.T, path string, want os.FileMode) {
	t.Helper()
	if runtime.GOOS == "windows" {
		return
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != want {
		t.Fatalf("config mode = %04o, want %04o", info.Mode().Perm(), want)
	}
}

func TestLoadRejectsInsecurePermissions(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows does not expose Unix permission bits")
	}
	path := filepath.Join(t.TempDir(), "agent.json")
	cfg := validConfig(t.TempDir())
	if err := Save(path, cfg); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(path); err == nil {
		t.Fatal("Load() accepted a group/world-readable credential file")
	}
}

func TestStorePersistsRepositoryRegistration(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.json")
	store := NewStore(path)
	cfg := validConfig(t.TempDir())
	if err := store.Set(cfg); err != nil {
		t.Fatal(err)
	}
	repositoryID := uuid.NewString()
	repositoryRoot := t.TempDir()
	if err := store.RegisterRepository(repositoryID, repositoryRoot); err != nil {
		t.Fatalf("RegisterRepository() error = %v", err)
	}
	loaded, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Repositories[repositoryID] != repositoryRoot {
		t.Fatalf("persisted root = %q, want %q", loaded.Repositories[repositoryID], repositoryRoot)
	}
}

func TestEndpointsPreserveServerBasePath(t *testing.T) {
	endpoint, err := Endpoint("https://relay.example.com/base/", "/api/devices/pair")
	if err != nil {
		t.Fatal(err)
	}
	if endpoint != "https://relay.example.com/base/api/devices/pair" {
		t.Fatalf("Endpoint() = %q", endpoint)
	}
	websocketEndpoint, err := WebSocketEndpoint("http://localhost:3000")
	if err != nil {
		t.Fatal(err)
	}
	if websocketEndpoint != "ws://localhost:3000/ws/agent" {
		t.Fatalf("WebSocketEndpoint() = %q", websocketEndpoint)
	}
}

func TestServerSlugIsStableSafeAndDistinct(t *testing.T) {
	// The same server yields the same slug whether or not it carries a trailing
	// slash, so re-running the installer for a server is idempotent.
	withoutSlash, err := ServerSlug("https://relaydock-shahzeb.duckdns.org")
	if err != nil {
		t.Fatal(err)
	}
	withSlash, err := ServerSlug("https://relaydock-shahzeb.duckdns.org/")
	if err != nil {
		t.Fatal(err)
	}
	if withoutSlash != withSlash {
		t.Fatalf("trailing slash changed slug: %q vs %q", withoutSlash, withSlash)
	}

	// The slug is filesystem- and launchd-label-safe: lowercase alphanumerics and
	// single dashes, no leading or trailing dash, and it keeps a readable host prefix.
	for _, character := range withoutSlash {
		safe := (character >= 'a' && character <= 'z') ||
			(character >= '0' && character <= '9') ||
			character == '-'
		if !safe {
			t.Fatalf("slug %q contains unsafe character %q", withoutSlash, character)
		}
	}
	if strings.HasPrefix(withoutSlash, "-") || strings.HasSuffix(withoutSlash, "-") {
		t.Fatalf("slug %q has a leading or trailing dash", withoutSlash)
	}
	if !strings.HasPrefix(withoutSlash, "relaydock-shahzeb-duckdns-org-") {
		t.Fatalf("slug %q dropped the readable host prefix", withoutSlash)
	}

	// Distinct servers never collide — including ones whose readable part sanitises
	// to the same base — because the slug ends in a hash of the canonical URL.
	seen := map[string]string{}
	for _, server := range []string{
		"https://relay.example.com",
		"https://relay.example.com:8443",
		"https://relay.example.com/base",
		"https://relay.example.org",
		"http://127.0.0.1:3000",
	} {
		slug, err := ServerSlug(server)
		if err != nil {
			t.Fatalf("ServerSlug(%q): %v", server, err)
		}
		if other, ok := seen[slug]; ok {
			t.Fatalf("slug collision: %q and %q both map to %q", other, server, slug)
		}
		seen[slug] = server
	}

	if _, err := ServerSlug("not-a-url"); err == nil {
		t.Fatal("ServerSlug accepted an invalid server URL")
	}
}
