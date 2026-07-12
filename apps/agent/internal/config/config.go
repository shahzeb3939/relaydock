package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"

	"github.com/google/uuid"
)

const EnvironmentConfigPath = "RELAYDOCK_CONFIG"

var DefaultAllowedEnvironment = []string{
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"TMPDIR",
	"TEMP",
	"TERM",
	"COLORTERM",
	"LANG",
	"LC_ALL",
	"SystemRoot",
	"ComSpec",
	"PATHEXT",
}

type Config struct {
	Server             string            `json:"server"`
	DeviceID           string            `json:"deviceId"`
	Credential         string            `json:"credential"`
	DeviceName         string            `json:"deviceName"`
	Repositories       map[string]string `json:"repositories"`
	AllowedEnvironment []string          `json:"allowedEnvironment,omitempty"`
	ExtraPath          []string          `json:"extraPath,omitempty"`
}

type Store struct {
	path string
	mu   sync.RWMutex
	cfg  Config
}

func DefaultPath() (string, error) {
	if value := strings.TrimSpace(os.Getenv(EnvironmentConfigPath)); value != "" {
		absolute, err := filepath.Abs(value)
		if err != nil {
			return "", fmt.Errorf("resolve %s: %w", EnvironmentConfigPath, err)
		}
		return filepath.Clean(absolute), nil
	}

	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("find home directory: %w", err)
	}
	return filepath.Join(home, ".config", "relaydock", "agent.json"), nil
}

func NewStore(path string) *Store {
	return &Store{path: path}
}

func (s *Store) Path() string {
	return s.path
}

func (s *Store) Load() (Config, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	cfg, err := Load(s.path)
	if err != nil {
		return Config{}, err
	}
	s.cfg = clone(cfg)
	return clone(cfg), nil
}

func (s *Store) Set(cfg Config) error {
	if err := cfg.Validate(); err != nil {
		return err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if err := Save(s.path, cfg); err != nil {
		return err
	}
	s.cfg = clone(cfg)
	return nil
}

func (s *Store) Snapshot() Config {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return clone(s.cfg)
}

func (s *Store) RegisterRepository(repositoryID, canonicalRoot string) error {
	if _, err := uuid.Parse(repositoryID); err != nil {
		return fmt.Errorf("invalid repository ID: %w", err)
	}
	if !filepath.IsAbs(canonicalRoot) {
		return errors.New("repository root must be absolute")
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	next := clone(s.cfg)
	if next.Repositories == nil {
		next.Repositories = make(map[string]string)
	}
	next.Repositories[repositoryID] = filepath.Clean(canonicalRoot)
	if err := Save(s.path, next); err != nil {
		return err
	}
	s.cfg = next
	return nil
}

func Load(path string) (Config, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return Config{}, fmt.Errorf("inspect agent configuration: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return Config{}, errors.New("agent configuration must be a regular file, not a symlink")
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0 {
		return Config{}, fmt.Errorf("agent configuration permissions must be 0600 or stricter (found %04o)", info.Mode().Perm())
	}

	file, err := os.Open(path)
	if err != nil {
		return Config{}, fmt.Errorf("open agent configuration: %w", err)
	}
	defer file.Close()

	var cfg Config
	decoder := json.NewDecoder(io.LimitReader(file, 1024*1024))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&cfg); err != nil {
		return Config{}, fmt.Errorf("decode agent configuration: %w", err)
	}
	if err := ensureJSONEOF(decoder); err != nil {
		return Config{}, err
	}
	if cfg.Repositories == nil {
		cfg.Repositories = make(map[string]string)
	}
	if len(cfg.AllowedEnvironment) == 0 {
		cfg.AllowedEnvironment = append([]string(nil), DefaultAllowedEnvironment...)
	}
	if err := cfg.Validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

func Save(path string, cfg Config) error {
	if err := cfg.Validate(); err != nil {
		return err
	}
	directory := filepath.Dir(path)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return fmt.Errorf("create configuration directory: %w", err)
	}

	temporary, err := os.CreateTemp(directory, ".agent.json-*")
	if err != nil {
		return fmt.Errorf("create temporary configuration: %w", err)
	}
	temporaryPath := temporary.Name()
	cleanup := func() {
		_ = temporary.Close()
		_ = os.Remove(temporaryPath)
	}
	defer cleanup()

	if err := temporary.Chmod(0o600); err != nil {
		return fmt.Errorf("secure temporary configuration: %w", err)
	}
	encoder := json.NewEncoder(temporary)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(cfg); err != nil {
		return fmt.Errorf("encode agent configuration: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		return fmt.Errorf("sync agent configuration: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close agent configuration: %w", err)
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return fmt.Errorf("install agent configuration: %w", err)
	}
	if runtime.GOOS != "windows" {
		if err := os.Chmod(path, 0o600); err != nil {
			return fmt.Errorf("secure agent configuration: %w", err)
		}
	}
	return nil
}

func (c Config) Validate() error {
	if _, err := ParseServerURL(c.Server); err != nil {
		return err
	}
	if _, err := uuid.Parse(c.DeviceID); err != nil {
		return fmt.Errorf("invalid device ID: %w", err)
	}
	if len(c.Credential) == 0 || len(c.Credential) > 4096 || strings.IndexFunc(c.Credential, func(character rune) bool {
		return character < 0x21 || character > 0x7e
	}) >= 0 {
		return errors.New("device credential must contain 1 to 4096 printable ASCII bytes without spaces")
	}
	if len(c.DeviceName) == 0 || len(c.DeviceName) > 100 {
		return errors.New("device name must contain 1 to 100 bytes")
	}
	for repositoryID, root := range c.Repositories {
		if _, err := uuid.Parse(repositoryID); err != nil {
			return fmt.Errorf("invalid repository ID %q: %w", repositoryID, err)
		}
		if !filepath.IsAbs(root) {
			return fmt.Errorf("repository %s root must be absolute", repositoryID)
		}
	}
	for _, name := range c.AllowedEnvironment {
		if name == "" || len(name) > 200 || strings.ContainsAny(name, "=\x00") {
			return fmt.Errorf("invalid allowed environment name %q", name)
		}
	}
	for _, path := range c.ExtraPath {
		if path == "" || !filepath.IsAbs(path) || strings.ContainsRune(path, os.PathListSeparator) {
			return fmt.Errorf("invalid extraPath entry %q", path)
		}
	}
	return nil
}

func ParseServerURL(raw string) (*url.URL, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return nil, fmt.Errorf("parse server URL: %w", err)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, errors.New("server URL scheme must be http or https")
	}
	if parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, errors.New("server URL must contain a host and no credentials, query, or fragment")
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/")
	return parsed, nil
}

func Endpoint(serverURL, endpoint string) (string, error) {
	parsed, err := ParseServerURL(serverURL)
	if err != nil {
		return "", err
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/") + "/" + strings.TrimLeft(endpoint, "/")
	return parsed.String(), nil
}

func WebSocketEndpoint(serverURL string) (string, error) {
	endpoint, err := Endpoint(serverURL, "/ws/agent")
	if err != nil {
		return "", err
	}
	parsed, err := url.Parse(endpoint)
	if err != nil {
		return "", err
	}
	if parsed.Scheme == "https" {
		parsed.Scheme = "wss"
	} else {
		parsed.Scheme = "ws"
	}
	return parsed.String(), nil
}

func ensureJSONEOF(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("agent configuration contains multiple JSON values")
		}
		return fmt.Errorf("decode trailing agent configuration data: %w", err)
	}
	return nil
}

func clone(cfg Config) Config {
	copyConfig := cfg
	copyConfig.Repositories = make(map[string]string, len(cfg.Repositories))
	for key, value := range cfg.Repositories {
		copyConfig.Repositories[key] = value
	}
	copyConfig.AllowedEnvironment = append([]string(nil), cfg.AllowedEnvironment...)
	copyConfig.ExtraPath = append([]string(nil), cfg.ExtraPath...)
	return copyConfig
}
