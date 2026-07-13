package installer

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/relaydock/relaydock/apps/agent/internal/client"
	"github.com/relaydock/relaydock/apps/agent/internal/config"
)

const pairingTimeout = 20 * time.Second

type Options struct {
	Server       string
	Code         string
	Name         string
	ConfigPath   string
	AgentVersion string
}

type Result struct {
	AlreadyPaired bool
	BinaryPath    string
	ConfigPath    string
	DeviceName    string
	ServicePath   string
}

type pairFunc func(context.Context, client.PairOptions) (config.Config, error)

type dependencies struct {
	goos           string
	uid            int
	homeDirectory  string
	executablePath string
	pair           pairFunc
	runner         commandRunner
}

func Install(ctx context.Context, options Options) (Result, error) {
	homeDirectory, err := os.UserHomeDir()
	if err != nil {
		return Result{}, fmt.Errorf("find home directory: %w", err)
	}
	executablePath, err := os.Executable()
	if err != nil {
		return Result{}, fmt.Errorf("find current agent executable: %w", err)
	}
	return install(ctx, options, dependencies{
		goos:           runtime.GOOS,
		uid:            effectiveUID(),
		homeDirectory:  homeDirectory,
		executablePath: executablePath,
		pair:           client.Pair,
		runner:         execCommandRunner{},
	})
}

func install(ctx context.Context, options Options, dependencies dependencies) (Result, error) {
	if dependencies.goos != "darwin" && dependencies.goos != "linux" {
		return Result{}, fmt.Errorf("automatic agent installation is not supported on %s; pair and configure the agent service manually", dependencies.goos)
	}
	if dependencies.uid == 0 {
		return Result{}, errors.New("refusing to install RelayDock as root; run the installer as the account that will execute commands")
	}
	if strings.TrimSpace(dependencies.homeDirectory) == "" || !filepath.IsAbs(dependencies.homeDirectory) {
		return Result{}, errors.New("home directory must be an absolute path")
	}
	if strings.TrimSpace(dependencies.executablePath) == "" || !filepath.IsAbs(dependencies.executablePath) {
		return Result{}, errors.New("current agent executable path must be absolute")
	}
	if strings.TrimSpace(options.Server) == "" {
		return Result{}, errors.New("--server is required")
	}
	server, err := config.ParseServerURL(options.Server)
	if err != nil {
		return Result{}, err
	}
	serverURL := server.String()
	configPath := options.ConfigPath
	if configPath == "" {
		configPath = filepath.Join(dependencies.homeDirectory, ".config", "relaydock", "agent.json")
	}
	if !filepath.IsAbs(configPath) {
		return Result{}, errors.New("agent configuration path must be absolute")
	}
	configPath = filepath.Clean(configPath)

	cfg, alreadyPaired, err := ensurePaired(ctx, options, serverURL, configPath, dependencies.pair)
	if err != nil {
		return Result{}, err
	}

	binaryPath := filepath.Join(dependencies.homeDirectory, ".local", "bin", "relaydock-agent")
	if err := installExecutable(dependencies.executablePath, binaryPath); err != nil {
		return Result{}, err
	}
	servicePath, err := installService(ctx, serviceOptions{
		GOOS:          dependencies.goos,
		UID:           dependencies.uid,
		HomeDirectory: dependencies.homeDirectory,
		BinaryPath:    binaryPath,
		ConfigPath:    configPath,
	}, dependencies.runner)
	if err != nil {
		return Result{}, err
	}
	return Result{
		AlreadyPaired: alreadyPaired,
		BinaryPath:    binaryPath,
		ConfigPath:    configPath,
		DeviceName:    cfg.DeviceName,
		ServicePath:   servicePath,
	}, nil
}

func ensurePaired(
	ctx context.Context,
	options Options,
	serverURL string,
	configPath string,
	pair pairFunc,
) (config.Config, bool, error) {
	_, err := os.Lstat(configPath)
	switch {
	case err == nil:
		cfg, loadErr := config.Load(configPath)
		if loadErr != nil {
			return config.Config{}, false, loadErr
		}
		existingServer, parseErr := config.ParseServerURL(cfg.Server)
		if parseErr != nil {
			return config.Config{}, false, parseErr
		}
		if existingServer.String() != serverURL {
			return config.Config{}, false, fmt.Errorf(
				"agent is already paired with %s; refusing to replace its credential with server %s",
				existingServer.String(),
				serverURL,
			)
		}
		return cfg, true, nil
	case !errors.Is(err, os.ErrNotExist):
		return config.Config{}, false, fmt.Errorf("inspect existing agent configuration: %w", err)
	}

	if strings.TrimSpace(options.Code) == "" {
		return config.Config{}, false, errors.New("--code is required because this device has not been paired")
	}
	pairContext, cancel := context.WithTimeout(ctx, pairingTimeout)
	defer cancel()
	cfg, err := pair(pairContext, client.PairOptions{
		Server:       serverURL,
		Code:         options.Code,
		Name:         options.Name,
		AgentVersion: options.AgentVersion,
	})
	if err != nil {
		return config.Config{}, false, err
	}
	if err := config.SaveNew(configPath, cfg); err != nil {
		if errors.Is(err, os.ErrExist) {
			return config.Config{}, false, fmt.Errorf("agent configuration appeared while pairing; preserved the existing file at %s: %w", configPath, err)
		}
		return config.Config{}, false, fmt.Errorf("save paired device configuration: %w", err)
	}
	return cfg, false, nil
}

func installExecutable(sourcePath, destinationPath string) error {
	same, err := sameFile(sourcePath, destinationPath)
	if err != nil {
		return err
	}
	if same {
		if err := os.Chmod(destinationPath, 0o755); err != nil {
			return fmt.Errorf("set installed agent executable permissions: %w", err)
		}
		return nil
	}
	source, err := os.Open(sourcePath)
	if err != nil {
		return fmt.Errorf("open current agent executable: %w", err)
	}
	defer source.Close()
	info, err := source.Stat()
	if err != nil {
		return fmt.Errorf("inspect current agent executable: %w", err)
	}
	if !info.Mode().IsRegular() {
		return errors.New("current agent executable must be a regular file")
	}
	if err := writeFileAtomically(destinationPath, 0o755, func(destination io.Writer) error {
		_, copyErr := io.Copy(destination, source)
		return copyErr
	}); err != nil {
		return fmt.Errorf("install agent executable: %w", err)
	}
	return nil
}

func sameFile(sourcePath, destinationPath string) (bool, error) {
	sourceInfo, err := os.Stat(sourcePath)
	if err != nil {
		return false, fmt.Errorf("inspect current agent executable: %w", err)
	}
	destinationInfo, err := os.Stat(destinationPath)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("inspect installed agent executable: %w", err)
	}
	return os.SameFile(sourceInfo, destinationInfo), nil
}
