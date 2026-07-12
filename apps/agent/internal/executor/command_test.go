package executor

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestBuildPassesShellArgumentsWithoutConcatenation(t *testing.T) {
	workingDirectory := t.TempDir()
	command, err := Build(CommandOptions{
		Shell:            filepath.Join(string(filepath.Separator), "bin", "sh"),
		ShellArgs:        []string{"-lc"},
		Command:          `printf '%s' "$HOME"`,
		WorkingDirectory: workingDirectory,
	})
	if err != nil {
		t.Fatalf("Build() error = %v", err)
	}
	want := []string{filepath.Join(string(filepath.Separator), "bin", "sh"), "-lc", `printf '%s' "$HOME"`}
	if !reflect.DeepEqual(command.Args, want) {
		t.Fatalf("Args = %#v, want %#v", command.Args, want)
	}
	if command.Dir != workingDirectory {
		t.Fatalf("Dir = %q, want %q", command.Dir, workingDirectory)
	}
}

func TestBuildFiltersEnvironmentAndPrependsExtraPath(t *testing.T) {
	t.Setenv("RELAYDOCK_ALLOWED_TEST", "visible")
	t.Setenv("RELAYDOCK_SECRET_TEST", "hidden")
	t.Setenv("PATH", "/system/bin")
	command, err := Build(CommandOptions{
		Shell:                "shell",
		Command:              "command",
		WorkingDirectory:     t.TempDir(),
		InheritedEnvironment: []string{"RELAYDOCK_ALLOWED_TEST", "RELAYDOCK_SECRET_TEST", "PATH"},
		AllowedEnvironment:   []string{"RELAYDOCK_ALLOWED_TEST", "PATH"},
		ExtraPath:            []string{"/extra/bin"},
	})
	if err != nil {
		t.Fatal(err)
	}
	environment := strings.Join(command.Env, "\n")
	if !strings.Contains(environment, "RELAYDOCK_ALLOWED_TEST=visible") {
		t.Fatalf("allowed value missing from Env: %#v", command.Env)
	}
	if strings.Contains(environment, "RELAYDOCK_SECRET_TEST") || strings.Contains(environment, "hidden") {
		t.Fatalf("disallowed value leaked into Env: %#v", command.Env)
	}
	wantPath := "PATH=/extra/bin" + string(os.PathListSeparator) + "/system/bin"
	if !strings.Contains(environment, wantPath) {
		t.Fatalf("Env = %#v, want %q", command.Env, wantPath)
	}
}

func TestBuildRejectsRelativeWorkingDirectory(t *testing.T) {
	_, err := Build(CommandOptions{Shell: "sh", Command: "true", WorkingDirectory: "relative"})
	if err == nil {
		t.Fatal("Build() accepted a relative working directory")
	}
}
