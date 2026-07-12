package config

import (
	"os"
	"path/filepath"
	"runtime"
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
