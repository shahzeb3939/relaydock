package installer

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

func ensurePrivateDirectory(path string) error {
	if err := os.MkdirAll(path, 0o700); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return errors.New("path must be a directory, not a symlink")
	}
	return os.Chmod(path, 0o700)
}

func writeFileAtomically(path string, mode os.FileMode, write func(io.Writer) error) error {
	directory := filepath.Dir(path)
	if err := os.MkdirAll(directory, 0o755); err != nil {
		return fmt.Errorf("create parent directory: %w", err)
	}
	temporary, err := os.CreateTemp(directory, ".relaydock-install-*")
	if err != nil {
		return fmt.Errorf("create temporary file: %w", err)
	}
	temporaryPath := temporary.Name()
	cleanup := func() {
		_ = temporary.Close()
		_ = os.Remove(temporaryPath)
	}
	defer cleanup()
	if err := temporary.Chmod(mode); err != nil {
		return fmt.Errorf("set temporary file permissions: %w", err)
	}
	if err := write(temporary); err != nil {
		return fmt.Errorf("write temporary file: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		return fmt.Errorf("sync temporary file: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close temporary file: %w", err)
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return fmt.Errorf("replace destination file: %w", err)
	}
	if err := os.Chmod(path, mode); err != nil {
		return fmt.Errorf("set destination permissions: %w", err)
	}
	return nil
}
