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
	"syscall"
	"time"

	"github.com/relaydock/relaydock/apps/agent/internal/client"
	"github.com/relaydock/relaydock/apps/agent/internal/config"
	"github.com/relaydock/relaydock/apps/agent/internal/repository"
	"github.com/relaydock/relaydock/apps/agent/internal/session"
)

const agentVersion = "0.1.0"

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
	path, err := resolveConfigPath(*configPath)
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

func resolveConfigPath(value string) (string, error) {
	if value == "" {
		return config.DefaultPath()
	}
	absolute, err := filepath.Abs(value)
	if err != nil {
		return "", fmt.Errorf("resolve configuration path: %w", err)
	}
	return filepath.Clean(absolute), nil
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
  relaydock-agent pair --server URL --code CODE [--name NAME]
  relaydock-agent run [--config PATH]
  relaydock-agent [--config PATH]
  relaydock-agent version

The default configuration path is ~/.config/relaydock/agent.json.
`)
}
