//go:build !windows

package session

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"syscall"

	"github.com/creack/pty"
)

func startPTY(command *exec.Cmd, columns, rows int) (io.ReadWriteCloser, error) {
	terminal, err := pty.StartWithSize(command, &pty.Winsize{Cols: uint16(columns), Rows: uint16(rows)})
	if err != nil {
		return nil, fmt.Errorf("start PTY: %w", err)
	}
	return terminal, nil
}

func resizePTY(terminal io.ReadWriteCloser, columns, rows int) error {
	file, ok := terminal.(*os.File)
	if !ok {
		return fmt.Errorf("PTY backend cannot be resized")
	}
	if err := pty.Setsize(file, &pty.Winsize{Cols: uint16(columns), Rows: uint16(rows)}); err != nil {
		return fmt.Errorf("resize PTY: %w", err)
	}
	return nil
}

func prepareNonInteractive(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func terminateProcess(process *os.Process) error {
	if err := syscall.Kill(-process.Pid, syscall.SIGKILL); err == nil {
		return nil
	}
	return process.Kill()
}
