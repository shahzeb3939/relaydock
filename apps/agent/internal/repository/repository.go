package repository

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

type Validation struct {
	Valid           bool
	CanonicalPath   string
	RepositoryRoot  string
	IsGitRepository bool
	Branch          string
	Error           string
}

type Registry struct {
	mu    sync.RWMutex
	roots map[string]string
}

func NewRegistry(initial map[string]string) *Registry {
	roots := make(map[string]string, len(initial))
	for repositoryID, root := range initial {
		roots[repositoryID] = filepath.Clean(root)
	}
	return &Registry{roots: roots}
}

func (r *Registry) Register(repositoryID, canonicalRoot string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.roots[repositoryID] = filepath.Clean(canonicalRoot)
}

func (r *Registry) Root(repositoryID string) (string, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	root, found := r.roots[repositoryID]
	return root, found
}

func (r *Registry) Match(repositoryID, requestedPath string) (string, error) {
	root, found := r.Root(repositoryID)
	if !found {
		return "", errors.New("repository is not registered on this device")
	}
	if !filepath.IsAbs(requestedPath) {
		return "", errors.New("repository path must be absolute")
	}
	requestedCanonical, err := filepath.EvalSymlinks(filepath.Clean(requestedPath))
	if err != nil {
		return "", fmt.Errorf("resolve requested repository path: %w", err)
	}
	rootCanonical, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", fmt.Errorf("resolve registered repository root: %w", err)
	}
	equal, err := pathsReferToSameDirectory(rootCanonical, requestedCanonical)
	if err != nil {
		return "", err
	}
	if !equal {
		return "", errors.New("requested repository path does not match its locally registered root")
	}
	return rootCanonical, nil
}

func ValidatePath(ctx context.Context, absolutePath string) Validation {
	if !filepath.IsAbs(absolutePath) {
		return invalid("repository path must be absolute")
	}
	canonicalPath, err := filepath.EvalSymlinks(filepath.Clean(absolutePath))
	if err != nil {
		return invalid(fmt.Sprintf("resolve repository path: %v", err))
	}
	if len(canonicalPath) > 4096 {
		return invalid("canonical repository path exceeds 4096 bytes")
	}
	info, err := os.Stat(canonicalPath)
	if err != nil {
		return invalid(fmt.Sprintf("inspect repository path: %v", err))
	}
	if !info.IsDir() {
		return invalid("repository path is not a directory")
	}
	directory, err := os.Open(canonicalPath)
	if err != nil {
		return invalid(fmt.Sprintf("open repository path: %v", err))
	}
	_, readError := directory.Readdirnames(1)
	closeError := directory.Close()
	if readError != nil && !errors.Is(readError, io.EOF) {
		return invalid(fmt.Sprintf("read repository path: %v", readError))
	}
	if closeError != nil {
		return invalid(fmt.Sprintf("close repository path: %v", closeError))
	}

	result := Validation{
		Valid:          true,
		CanonicalPath:  canonicalPath,
		RepositoryRoot: canonicalPath,
	}
	gitContext, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	rootOutput, err := exec.CommandContext(gitContext, "git", "-C", canonicalPath, "rev-parse", "--show-toplevel").Output()
	if err != nil {
		return result
	}
	gitRoot, err := filepath.EvalSymlinks(strings.TrimSpace(string(rootOutput)))
	if err != nil || len(gitRoot) > 4096 {
		return result
	}
	result.IsGitRepository = true
	result.RepositoryRoot = gitRoot

	branchOutput, err := exec.CommandContext(gitContext, "git", "-C", canonicalPath, "branch", "--show-current").Output()
	if err == nil {
		result.Branch = strings.TrimSpace(string(branchOutput))
		if len(result.Branch) > 500 {
			result.Branch = result.Branch[:500]
		}
	}
	return result
}

func ResolveWorkingDirectory(root, workingDirectory string) (string, error) {
	if !filepath.IsAbs(root) {
		return "", errors.New("registered repository root must be absolute")
	}
	canonicalRoot, err := filepath.EvalSymlinks(filepath.Clean(root))
	if err != nil {
		return "", fmt.Errorf("resolve repository root: %w", err)
	}

	candidate := workingDirectory
	if candidate == "" {
		candidate = "."
	}
	if !filepath.IsAbs(candidate) {
		candidate = filepath.Join(canonicalRoot, candidate)
	}
	candidate = filepath.Clean(candidate)
	if !isWithin(canonicalRoot, candidate) {
		return "", errors.New("working directory escapes the registered repository root")
	}
	canonicalCandidate, err := filepath.EvalSymlinks(candidate)
	if err != nil {
		return "", fmt.Errorf("resolve working directory: %w", err)
	}
	if !isWithin(canonicalRoot, canonicalCandidate) {
		return "", errors.New("working directory resolves outside the registered repository root")
	}
	info, err := os.Stat(canonicalCandidate)
	if err != nil {
		return "", fmt.Errorf("inspect working directory: %w", err)
	}
	if !info.IsDir() {
		return "", errors.New("working directory is not a directory")
	}
	return canonicalCandidate, nil
}

func isWithin(root, candidate string) bool {
	relative, err := filepath.Rel(filepath.Clean(root), filepath.Clean(candidate))
	if err != nil {
		return false
	}
	return relative == "." || (relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)))
}

func pathsReferToSameDirectory(first, second string) (bool, error) {
	firstInfo, err := os.Stat(first)
	if err != nil {
		return false, fmt.Errorf("inspect registered repository root: %w", err)
	}
	secondInfo, err := os.Stat(second)
	if err != nil {
		return false, fmt.Errorf("inspect requested repository path: %w", err)
	}
	if !firstInfo.IsDir() || !secondInfo.IsDir() {
		return false, errors.New("repository root must be a directory")
	}
	if os.SameFile(firstInfo, secondInfo) {
		return true, nil
	}
	if runtime.GOOS == "windows" {
		return strings.EqualFold(filepath.Clean(first), filepath.Clean(second)), nil
	}
	return filepath.Clean(first) == filepath.Clean(second), nil
}

func invalid(message string) Validation {
	if len(message) > 1000 {
		message = message[:1000]
	}
	return Validation{Valid: false, Error: message}
}
