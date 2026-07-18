package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/relaydock/relaydock/apps/agent/internal/client"
	"github.com/relaydock/relaydock/apps/agent/internal/config"
	"github.com/relaydock/relaydock/apps/agent/internal/installer"
	"github.com/relaydock/relaydock/apps/agent/internal/repository"
	"github.com/relaydock/relaydock/apps/agent/internal/session"
)

var agentVersion = "0.1.0"

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintf(os.Stderr, "relaydock-agent: %v\n", err)
		os.Exit(1)
	}
}

func run(arguments []string) error {
	if len(arguments) == 0 {
		return runAgent(nil)
	}
	switch arguments[0] {
	case "pair":
		return runPair(arguments[1:])
	case "install":
		return runInstall(arguments[1:])
	case "run":
		return runAgent(arguments[1:])
	case "version", "--version", "-version":
		fmt.Printf("relaydock-agent %s\n", agentVersion)
		return nil
	case "help", "--help", "-h":
		printUsage()
		return nil
	default:
		if len(arguments[0]) > 0 && arguments[0][0] == '-' {
			return runAgent(arguments)
		}
		printUsage()
		return fmt.Errorf("unknown command %q", arguments[0])
	}
}

func runInstall(arguments []string) error {
	flags := flag.NewFlagSet("install", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	server := flags.String("server", "", "RelayDock server URL")
	code := flags.String("code", "", "one-time pairing code (required only when not already paired)")
	name := flags.String("name", defaultDeviceName(), "device name shown in RelayDock")
	configPath := flags.String("config", "", "agent configuration path")
	if err := flags.Parse(arguments); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("install does not accept positional arguments")
	}
	// Leave the path empty when neither --config nor RELAYDOCK_CONFIG is set so the
	// installer can place the agent in its per-server namespaced home. Resolving to
	// the legacy default here would defeat namespacing and let a second server's
	// install overwrite the first server's configuration.
	path, err := resolveInstallConfigPath(*configPath)
	if err != nil {
		return err
	}
	result, err := installer.Install(context.Background(), installer.Options{
		Server:       *server,
		Code:         *code,
		Name:         *name,
		ConfigPath:   path,
		AgentVersion: agentVersion,
	})
	if err != nil {
		return err
	}
	switch {
	case result.ReplacedPrevious:
		fmt.Printf("Re-paired device %q with a fresh credential; the previous credential was moved to %s.\n", result.DeviceName, result.BackupPath)
	case result.AlreadyPaired:
		fmt.Printf("Device is already paired as %q. Existing credential preserved at %s.\n", result.DeviceName, result.ConfigPath)
	default:
		fmt.Printf("Paired device %q. Configuration saved to %s.\n", result.DeviceName, result.ConfigPath)
	}
	fmt.Printf("Installed RelayDock agent to %s and started its background service.\n", result.BinaryPath)
	return nil
}

func runPair(arguments []string) error {
	flags := flag.NewFlagSet("pair", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	server := flags.String("server", "", "RelayDock server URL")
	code := flags.String("code", "", "one-time pairing code")
	name := flags.String("name", defaultDeviceName(), "device name shown in RelayDock")
	configPath := flags.String("config", "", "agent configuration path")
	force := flags.Bool("force", false, "replace an existing agent configuration")
	if err := flags.Parse(arguments); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("pair does not accept positional arguments")
	}
	// Pair creates the configuration for a specific --server, so it targets that
	// server's namespaced path (like install) rather than run's discovery — otherwise
	// `pair --server B --force` with no --config could overwrite another server's agent.
	path, err := resolvePairConfigPath(*configPath, *server)
	if err != nil {
		return err
	}
	if !*force {
		if _, err := os.Lstat(path); err == nil {
			return fmt.Errorf("configuration already exists at %s (use --force to replace it)", path)
		} else if !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("inspect existing configuration: %w", err)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cfg, err := client.Pair(ctx, client.PairOptions{
		Server:       *server,
		Code:         *code,
		Name:         *name,
		AgentVersion: agentVersion,
	})
	if err != nil {
		return err
	}
	store := config.NewStore(path)
	if err := store.Set(cfg); err != nil {
		return fmt.Errorf("save paired device configuration: %w", err)
	}
	fmt.Printf("Paired device %q. Configuration saved to %s.\n", cfg.DeviceName, path)
	return nil
}

func runAgent(arguments []string) error {
	flags := flag.NewFlagSet("run", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	configPath := flags.String("config", "", "agent configuration path")
	if err := flags.Parse(arguments); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("run does not accept positional arguments")
	}
	path, err := resolveConfigPath(*configPath)
	if err != nil {
		return err
	}
	store := config.NewStore(path)
	cfg, err := store.Load()
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("agent is not paired; run relaydock-agent pair first: %w", err)
		}
		return err
	}
	registry := repository.NewRegistry(cfg.Repositories)
	sessions := session.NewManager(registry, store.Snapshot)
	logger := log.New(os.Stderr, "relaydock-agent: ", log.Ldate|log.Ltime|log.LUTC)
	agentClient := client.New(store, registry, sessions, agentVersion, logger)
	sessions.SetTransport(agentClient)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	runError := agentClient.Run(ctx)
	shutdownContext, cancelShutdown := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelShutdown()
	if err := sessions.Close(shutdownContext); err != nil {
		logger.Printf("session shutdown did not complete: %v", err)
	}
	return runError
}

// resolveInstallConfigPath resolves the configuration path for `install`. It returns
// "" when neither --config nor RELAYDOCK_CONFIG is set so the installer can choose a
// per-server namespaced path; an explicit --config or RELAYDOCK_CONFIG is honored and
// made absolute.
func resolveInstallConfigPath(flagValue string) (string, error) {
	value := strings.TrimSpace(flagValue)
	if value == "" {
		value = strings.TrimSpace(os.Getenv(config.EnvironmentConfigPath))
	}
	if value == "" {
		return "", nil
	}
	return absoluteConfigPath(value)
}

// resolvePairConfigPath resolves the configuration path for `pair`. An explicit
// --config or RELAYDOCK_CONFIG wins; otherwise pair targets the namespaced path for
// its own --server (the same path install would use) so a forced re-pair can never
// overwrite a different server's agent.
func resolvePairConfigPath(flagValue, server string) (string, error) {
	value := strings.TrimSpace(flagValue)
	if value == "" {
		value = strings.TrimSpace(os.Getenv(config.EnvironmentConfigPath))
	}
	if value != "" {
		return absoluteConfigPath(value)
	}
	slug, err := config.ServerSlug(server)
	if err != nil {
		return "", err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("find home directory: %w", err)
	}
	return filepath.Join(home, ".config", "relaydock", "agents", slug+".json"), nil
}

// resolveConfigPath resolves the configuration path for `run` (and a bare invocation).
// An explicit value (or RELAYDOCK_CONFIG) wins; otherwise it prefers the legacy path
// when it still exists and falls back to the sole namespaced agent, erroring with the
// list when more than one namespaced agent is configured so a bare `run` never
// silently targets the wrong (or a removed) configuration.
func resolveConfigPath(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value != "" {
		return absoluteConfigPath(value)
	}
	if env := strings.TrimSpace(os.Getenv(config.EnvironmentConfigPath)); env != "" {
		return absoluteConfigPath(env)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("find home directory: %w", err)
	}
	legacy := filepath.Join(home, ".config", "relaydock", "agent.json")
	if _, err := os.Stat(legacy); err == nil {
		return legacy, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", fmt.Errorf("inspect agent configuration: %w", err)
	}
	namespaced, err := namespacedConfigPaths(home)
	if err != nil {
		return "", err
	}
	switch len(namespaced) {
	case 0:
		// Nothing configured yet; return the legacy path so callers surface the
		// familiar "agent is not paired" guidance.
		return legacy, nil
	case 1:
		return namespaced[0], nil
	default:
		return "", fmt.Errorf("multiple agents are configured; pass --config with one of:\n  %s", strings.Join(namespaced, "\n  "))
	}
}

func absoluteConfigPath(value string) (string, error) {
	absolute, err := filepath.Abs(value)
	if err != nil {
		return "", fmt.Errorf("resolve configuration path: %w", err)
	}
	return filepath.Clean(absolute), nil
}

// namespacedConfigPaths lists per-server agent configurations under the agents
// directory, sorted so any resulting message is stable.
func namespacedConfigPaths(home string) ([]string, error) {
	directory := filepath.Join(home, ".config", "relaydock", "agents")
	entries, err := os.ReadDir(directory)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("list configured agents: %w", err)
	}
	var paths []string
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		paths = append(paths, filepath.Join(directory, entry.Name()))
	}
	sort.Strings(paths)
	return paths, nil
}

func defaultDeviceName() string {
	hostname, err := os.Hostname()
	if err != nil || hostname == "" {
		return "RelayDock agent"
	}
	if len(hostname) > 100 {
		return hostname[:100]
	}
	return hostname
}

func printUsage() {
	fmt.Print(`RelayDock laptop agent

Usage:
  relaydock-agent install --server URL [--code CODE] [--name NAME]
  relaydock-agent pair --server URL --code CODE [--name NAME]
  relaydock-agent run [--config PATH]
  relaydock-agent [--config PATH]
  relaydock-agent version

Each server gets its own agent under ~/.config/relaydock/agents/. When --config
is omitted, install derives the path from --server, and run/pair use the sole
configured agent (pass --config when more than one server is paired).
`)
}
