//go:build windows

package session

import (
	"errors"
	"io"
	"os"
	"os/exec"
)

func startPTY(_ *exec.Cmd, _, _ int) (io.ReadWriteCloser, error) {
	return nil, errors.New("interactive PTY jobs are not supported by the Windows MVP agent")
}

func resizePTY(_ io.ReadWriteCloser, _, _ int) error {
	return errors.New("terminal resizing is not supported by the Windows MVP agent")
}

func prepareNonInteractive(_ *exec.Cmd) {}

func terminateProcess(process *os.Process) error {
	return process.Kill()
}
