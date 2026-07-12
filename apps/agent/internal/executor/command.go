package executor

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/relaydock/relaydock/apps/agent/internal/protocol"
)

type CommandOptions struct {
	Shell                string
	ShellArgs            []string
	Command              string
	WorkingDirectory     string
	InheritedEnvironment []string
	AllowedEnvironment   []string
	ExtraPath            []string
	Interactive          bool
}

func Build(options CommandOptions) (*exec.Cmd, error) {
	if strings.TrimSpace(options.Shell) == "" || strings.ContainsRune(options.Shell, '\x00') {
		return nil, errors.New("shell must be non-empty and contain no NUL")
	}
	if options.Command == "" || len(options.Command) > protocol.MaxCommandBytes || strings.ContainsRune(options.Command, '\x00') {
		return nil, fmt.Errorf("command must contain 1 to %d bytes and no NUL", protocol.MaxCommandBytes)
	}
	if !filepath.IsAbs(options.WorkingDirectory) {
		return nil, errors.New("working directory must be absolute")
	}
	if len(options.ShellArgs) > protocol.MaximumShellArguments {
		return nil, fmt.Errorf("at most %d shell arguments are allowed", protocol.MaximumShellArguments)
	}
	arguments := make([]string, 0, len(options.ShellArgs)+1)
	for _, argument := range options.ShellArgs {
		if len(argument) > 1000 || strings.ContainsRune(argument, '\x00') {
			return nil, errors.New("shell argument is invalid")
		}
		arguments = append(arguments, argument)
	}
	arguments = append(arguments, options.Command)

	command := exec.Command(options.Shell, arguments...)
	command.Dir = options.WorkingDirectory
	command.Env = inheritedEnvironment(
		options.InheritedEnvironment,
		options.AllowedEnvironment,
		options.ExtraPath,
		options.Interactive,
	)
	return command, nil
}

func inheritedEnvironment(requested, allowed, extraPath []string, interactive bool) []string {
	allowedSet := make(map[string]struct{}, len(allowed))
	for _, name := range allowed {
		allowedSet[normalizeEnvironmentName(name)] = struct{}{}
	}
	seen := make(map[string]struct{}, len(requested)+1)
	result := make([]string, 0, len(requested)+1)
	pathIncluded := false
	termIncluded := false
	for _, name := range requested {
		normalized := normalizeEnvironmentName(name)
		if _, ok := allowedSet[normalized]; !ok {
			continue
		}
		if _, duplicate := seen[normalized]; duplicate {
			continue
		}
		value, exists := os.LookupEnv(name)
		if !exists && runtime.GOOS == "windows" {
			value, exists = lookupEnvironmentFold(name)
		}
		if !exists {
			continue
		}
		if normalized == normalizeEnvironmentName("PATH") {
			pathIncluded = true
			if len(extraPath) > 0 {
				value = strings.Join(extraPath, string(os.PathListSeparator)) + string(os.PathListSeparator) + value
			}
		}
		if normalized == normalizeEnvironmentName("TERM") {
			termIncluded = true
		}
		result = append(result, name+"="+value)
		seen[normalized] = struct{}{}
	}
	if len(extraPath) > 0 && !pathIncluded {
		value := strings.Join(extraPath, string(os.PathListSeparator))
		if current := os.Getenv("PATH"); current != "" {
			value += string(os.PathListSeparator) + current
		}
		result = append(result, "PATH="+value)
	}
	if interactive && !termIncluded {
		result = append(result, "TERM=xterm-256color")
	}
	return result
}

func normalizeEnvironmentName(name string) string {
	if runtime.GOOS == "windows" {
		return strings.ToUpper(name)
	}
	return name
}

func lookupEnvironmentFold(name string) (string, bool) {
	for _, entry := range os.Environ() {
		key, value, found := strings.Cut(entry, "=")
		if found && strings.EqualFold(key, name) {
			return value, true
		}
	}
	return "", false
}
