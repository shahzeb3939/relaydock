package repository

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/google/uuid"
)

func TestResolveWorkingDirectory(t *testing.T) {
	root := t.TempDir()
	nested := filepath.Join(root, "packages", "app")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatal(err)
	}
	resolved, err := ResolveWorkingDirectory(root, filepath.Join("packages", "app"))
	if err != nil {
		t.Fatalf("ResolveWorkingDirectory() error = %v", err)
	}
	canonical, _ := filepath.EvalSymlinks(nested)
	if resolved != canonical {
		t.Fatalf("resolved = %q, want %q", resolved, canonical)
	}
}

func TestResolveWorkingDirectoryRejectsTraversal(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if _, err := ResolveWorkingDirectory(root, filepath.Join("..", filepath.Base(outside))); err == nil {
		t.Fatal("ResolveWorkingDirectory() accepted traversal outside the root")
	}
}

func TestResolveWorkingDirectoryRejectsEscapingSymlink(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation commonly requires elevated Windows privileges")
	}
	root := t.TempDir()
	outside := t.TempDir()
	link := filepath.Join(root, "outside")
	if err := os.Symlink(outside, link); err != nil {
		t.Fatal(err)
	}
	if _, err := ResolveWorkingDirectory(root, "outside"); err == nil {
		t.Fatal("ResolveWorkingDirectory() accepted a symlink outside the root")
	}
}

func TestRegistryRequiresIDAndPathMatch(t *testing.T) {
	root := t.TempDir()
	other := t.TempDir()
	repositoryID := uuid.NewString()
	registry := NewRegistry(map[string]string{repositoryID: root})
	if _, err := registry.Match(repositoryID, root); err != nil {
		t.Fatalf("Match() rejected registered path: %v", err)
	}
	if _, err := registry.Match(repositoryID, other); err == nil {
		t.Fatal("Match() accepted a different path for the registered ID")
	}
	if _, err := registry.Match(uuid.NewString(), root); err == nil {
		t.Fatal("Match() accepted an unregistered repository ID")
	}
}

func TestValidatePathCanonicalizesDirectory(t *testing.T) {
	root := t.TempDir()
	result := ValidatePath(context.Background(), root)
	if !result.Valid {
		t.Fatalf("ValidatePath() invalid: %s", result.Error)
	}
	canonical, _ := filepath.EvalSymlinks(root)
	if result.CanonicalPath != canonical {
		t.Fatalf("canonical path = %q, want %q", result.CanonicalPath, canonical)
	}
}
