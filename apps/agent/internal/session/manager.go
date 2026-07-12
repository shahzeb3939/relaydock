package session

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/relaydock/relaydock/apps/agent/internal/config"
	"github.com/relaydock/relaydock/apps/agent/internal/executor"
	"github.com/relaydock/relaydock/apps/agent/internal/protocol"
	"github.com/relaydock/relaydock/apps/agent/internal/replay"
	"github.com/relaydock/relaydock/apps/agent/internal/repository"
)

const (
	outputReadBytes   = 32 * 1024
	maxRetainedJobs   = 100
	maximumErrorBytes = 2000
)

type Transport interface {
	Send(messageType string, payload any) error
}

type Manager struct {
	mu       sync.RWMutex
	sessions map[string]*Session
	registry *repository.Registry
	config   func() config.Config
	sender   Transport
	closed   bool
	wait     sync.WaitGroup
}

type Session struct {
	manager      *Manager
	request      protocol.JobStart
	buffer       *replay.Buffer
	startedAt    time.Time
	lastActivity time.Time

	mu         sync.RWMutex
	inputMu    sync.Mutex
	terminalMu sync.Mutex
	process    *os.Process
	terminal   io.ReadWriteCloser
	status     string
	pid        int
	done       bool
	cancelled  bool
	exitCode   *int
	failure    string
	lastInput  int64
	columns    int
	rows       int
}

func NewManager(registry *repository.Registry, configSnapshot func() config.Config) *Manager {
	return &Manager{
		sessions: make(map[string]*Session),
		registry: registry,
		config:   configSnapshot,
	}
}

func (m *Manager) SetTransport(sender Transport) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.sender = sender
}

func (m *Manager) Start(request protocol.JobStart) {
	m.mu.Lock()
	if existing := m.sessions[request.JobID]; existing != nil {
		sender := m.sender
		m.mu.Unlock()
		if sender != nil {
			_ = sender.Send("job.accepted", protocol.JobReference{JobID: request.JobID})
			existing.reconcile(sender)
		}
		return
	}
	if m.closed {
		sender := m.sender
		m.mu.Unlock()
		if sender != nil {
			_ = sender.Send("job.failed", protocol.JobFailed{JobID: request.JobID, Error: "agent is shutting down"})
		}
		return
	}
	m.mu.Unlock()

	root, err := m.registry.Match(request.RepositoryID, request.RepositoryPath)
	if err != nil {
		m.failStart(request.JobID, fmt.Errorf("reject repository: %w", err))
		return
	}
	workingDirectory, err := repository.ResolveWorkingDirectory(root, request.WorkingDirectory)
	if err != nil {
		m.failStart(request.JobID, fmt.Errorf("reject working directory: %w", err))
		return
	}
	cfg := m.config()
	command, err := executor.Build(executor.CommandOptions{
		Shell:                request.Shell,
		ShellArgs:            request.ShellArgs,
		Command:              request.Command,
		WorkingDirectory:     workingDirectory,
		InheritedEnvironment: request.InheritedEnvironment,
		AllowedEnvironment:   cfg.AllowedEnvironment,
		ExtraPath:            cfg.ExtraPath,
		Interactive:          request.Interactive,
	})
	if err != nil {
		m.failStart(request.JobID, fmt.Errorf("reject command: %w", err))
		return
	}

	now := time.Now()
	session := &Session{
		manager:      m,
		request:      request,
		buffer:       replay.New(replay.DefaultMaxChunks, replay.DefaultMaxBytes),
		startedAt:    now,
		lastActivity: now,
		status:       "dispatched",
		lastInput:    -1,
		columns:      request.Columns,
		rows:         request.Rows,
	}
	m.mu.Lock()
	if existing := m.sessions[request.JobID]; existing != nil {
		m.mu.Unlock()
		existing.reconcile(m.transport())
		return
	}
	if !m.makeRoomLocked() {
		sender := m.sender
		m.mu.Unlock()
		if sender != nil {
			_ = sender.Send("job.failed", protocol.JobFailed{
				JobID: request.JobID,
				Error: fmt.Sprintf("agent refuses more than %d concurrent or retained jobs", maxRetainedJobs),
			})
		}
		return
	}
	m.sessions[request.JobID] = session
	m.wait.Add(1)
	sender := m.sender
	m.mu.Unlock()
	if sender != nil {
		_ = sender.Send("job.accepted", protocol.JobReference{JobID: request.JobID})
	}
	go func() {
		defer m.wait.Done()
		session.run(command)
		m.prune()
	}()
}

func (m *Manager) Input(request protocol.JobInput) {
	if session := m.get(request.JobID); session != nil {
		session.writeInput(request.InputSequence, request.Data)
	}
}

func (m *Manager) Resize(request protocol.JobResize) {
	if session := m.get(request.JobID); session != nil {
		session.resize(request.Columns, request.Rows)
	}
}

func (m *Manager) Cancel(jobID string) {
	if session := m.get(jobID); session != nil {
		session.cancel()
	}
}

func (m *Manager) Sync(jobID string, afterSequence int64) {
	if session := m.get(jobID); session != nil {
		session.syncBuffer(m.transport(), afterSequence)
	}
}

func (m *Manager) ReconcileAll() {
	sender := m.transport()
	if sender == nil {
		return
	}
	for _, session := range m.snapshot() {
		session.syncBuffer(sender, -1)
		session.reconcile(sender)
	}
}

func (m *Manager) RunningJobIDs() []string {
	sessions := m.snapshot()
	result := make([]string, 0, len(sessions))
	for _, session := range sessions {
		session.mu.RLock()
		if !session.done {
			result = append(result, session.request.JobID)
		}
		session.mu.RUnlock()
	}
	sort.Strings(result)
	if len(result) > protocol.MaximumRunningJobIDs {
		result = result[:protocol.MaximumRunningJobIDs]
	}
	return result
}

func (m *Manager) Close(ctx context.Context) error {
	m.mu.Lock()
	m.closed = true
	sessions := make([]*Session, 0, len(m.sessions))
	for _, session := range m.sessions {
		sessions = append(sessions, session)
	}
	m.mu.Unlock()
	for _, session := range sessions {
		session.cancel()
	}
	done := make(chan struct{})
	go func() {
		m.wait.Wait()
		close(done)
	}()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (m *Manager) failStart(jobID string, err error) {
	sender := m.transport()
	if sender == nil {
		return
	}
	_ = sender.Send("job.failed", protocol.JobFailed{JobID: jobID, Error: safeError(err)})
}

func (m *Manager) get(jobID string) *Session {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.sessions[jobID]
}

func (m *Manager) snapshot() []*Session {
	m.mu.RLock()
	defer m.mu.RUnlock()
	result := make([]*Session, 0, len(m.sessions))
	for _, session := range m.sessions {
		result = append(result, session)
	}
	return result
}

func (m *Manager) transport() Transport {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.sender
}

func (m *Manager) prune() {
	m.mu.Lock()
	defer m.mu.Unlock()
	_ = m.evictCompletedLocked(maxRetainedJobs)
}

func (m *Manager) makeRoomLocked() bool {
	return m.evictCompletedLocked(maxRetainedJobs - 1)
}

func (m *Manager) evictCompletedLocked(target int) bool {
	if len(m.sessions) <= target {
		return true
	}
	completed := make([]*Session, 0, len(m.sessions))
	for _, session := range m.sessions {
		session.mu.RLock()
		done := session.done
		session.mu.RUnlock()
		if done {
			completed = append(completed, session)
		}
	}
	sort.Slice(completed, func(first, second int) bool {
		return completed[first].startedAt.Before(completed[second].startedAt)
	})
	for len(m.sessions) > target && len(completed) > 0 {
		delete(m.sessions, completed[0].request.JobID)
		completed = completed[1:]
	}
	return len(m.sessions) <= target
}

func (s *Session) run(command *exec.Cmd) {
	if s.request.Interactive {
		s.runInteractive(command)
		return
	}
	s.runNonInteractive(command)
}

func (s *Session) runNonInteractive(command *exec.Cmd) {
	prepareNonInteractive(command)
	stdout, err := command.StdoutPipe()
	if err != nil {
		s.finishStartFailure(err)
		return
	}
	stderr, err := command.StderrPipe()
	if err != nil {
		s.finishStartFailure(err)
		return
	}
	if err := command.Start(); err != nil {
		s.finishStartFailure(err)
		return
	}
	s.started(command.Process, nil, "running")

	var readers sync.WaitGroup
	readers.Add(2)
	go func() {
		defer readers.Done()
		s.readOutput(stdout, "stdout")
	}()
	go func() {
		defer readers.Done()
		s.readOutput(stderr, "stderr")
	}()
	readers.Wait()
	waitError := command.Wait()
	s.finish(command, waitError)
}

func (s *Session) runInteractive(command *exec.Cmd) {
	terminal, err := startPTY(command, s.columns, s.rows)
	if err != nil {
		s.finishStartFailure(err)
		return
	}
	s.started(command.Process, terminal, "waiting_for_input")
	s.readOutput(terminal, "stdout")
	waitError := command.Wait()
	s.terminalMu.Lock()
	_ = terminal.Close()
	s.terminalMu.Unlock()
	s.finish(command, waitError)
}

func (s *Session) started(process *os.Process, terminal io.ReadWriteCloser, status string) {
	s.mu.Lock()
	s.process = process
	s.terminal = terminal
	s.pid = process.Pid
	s.status = status
	cancelled := s.cancelled
	s.lastActivity = time.Now()
	s.mu.Unlock()
	sender := s.manager.transport()
	if sender != nil {
		_ = sender.Send("job.started", protocol.JobStarted{JobID: s.request.JobID, PID: process.Pid})
		_ = sender.Send("job.status", protocol.JobStatus{JobID: s.request.JobID, Status: status})
	}
	if cancelled {
		_ = terminateProcess(process)
	}
}

func (s *Session) readOutput(reader io.Reader, stream string) {
	buffer := make([]byte, outputReadBytes)
	for {
		count, err := reader.Read(buffer)
		if count > 0 {
			data := strings.ToValidUTF8(string(buffer[:count]), "\uFFFD")
			s.emitOutput(stream, data)
		}
		if err != nil {
			return
		}
	}
}

func (s *Session) emitOutput(stream, data string) {
	chunk := s.buffer.Add(stream, data)
	s.mu.Lock()
	s.lastActivity = time.Now()
	s.mu.Unlock()
	if sender := s.manager.transport(); sender != nil {
		_ = sender.Send("job.output", protocol.JobOutput{
			JobID:    s.request.JobID,
			Sequence: chunk.Sequence,
			Stream:   chunk.Stream,
			Data:     chunk.Data,
		})
	}
}

func (s *Session) finishStartFailure(err error) {
	s.mu.Lock()
	s.done = true
	s.status = "failed"
	s.failure = safeError(fmt.Errorf("start command: %w", err))
	s.lastActivity = time.Now()
	s.mu.Unlock()
	if sender := s.manager.transport(); sender != nil {
		_ = sender.Send("job.failed", protocol.JobFailed{JobID: s.request.JobID, Error: s.failure})
	}
}

func (s *Session) finish(command *exec.Cmd, waitError error) {
	exitCode := command.ProcessState.ExitCode()
	s.mu.Lock()
	s.process = nil
	s.terminal = nil
	s.done = true
	s.exitCode = &exitCode
	s.lastActivity = time.Now()
	cancelled := s.cancelled
	if cancelled {
		s.status = "cancelled"
	} else if waitError == nil {
		s.status = "completed"
	} else {
		s.status = "failed"
		s.failure = safeError(fmt.Errorf("command exited with code %d", exitCode))
	}
	s.mu.Unlock()

	sender := s.manager.transport()
	if sender == nil {
		return
	}
	if cancelled {
		_ = sender.Send("job.cancelled", protocol.JobReference{JobID: s.request.JobID})
	} else if waitError == nil {
		_ = sender.Send("job.completed", protocol.JobCompleted{JobID: s.request.JobID, ExitCode: exitCode})
	} else {
		_ = sender.Send("job.failed", protocol.JobFailed{JobID: s.request.JobID, Error: s.failure, ExitCode: &exitCode})
	}
}

func (s *Session) writeInput(sequence int64, data string) {
	s.inputMu.Lock()
	defer s.inputMu.Unlock()
	s.mu.RLock()
	terminal := s.terminal
	lastInput := s.lastInput
	done := s.done
	s.mu.RUnlock()
	if sequence <= lastInput {
		if sender := s.manager.transport(); sender != nil {
			_ = sender.Send("job.input.acknowledged", protocol.InputAcknowledged{JobID: s.request.JobID, InputSequence: sequence})
		}
		return
	}
	if terminal == nil || done {
		return
	}
	s.terminalMu.Lock()
	defer s.terminalMu.Unlock()
	if _, err := io.WriteString(terminal, data); err != nil {
		return
	}
	s.mu.Lock()
	s.lastInput = sequence
	s.lastActivity = time.Now()
	s.mu.Unlock()
	if sender := s.manager.transport(); sender != nil {
		_ = sender.Send("job.input.acknowledged", protocol.InputAcknowledged{JobID: s.request.JobID, InputSequence: sequence})
	}
}

func (s *Session) resize(columns, rows int) {
	s.mu.RLock()
	terminal := s.terminal
	done := s.done
	s.mu.RUnlock()
	if terminal == nil || done {
		return
	}
	s.terminalMu.Lock()
	defer s.terminalMu.Unlock()
	if err := resizePTY(terminal, columns, rows); err != nil {
		if sender := s.manager.transport(); sender != nil {
			_ = sender.Send("job.status", protocol.JobStatus{JobID: s.request.JobID, Status: s.currentStatus(), Detail: safeDetail(err)})
		}
		return
	}
	s.mu.Lock()
	s.columns = columns
	s.rows = rows
	s.lastActivity = time.Now()
	s.mu.Unlock()
}

func (s *Session) cancel() {
	s.mu.Lock()
	if s.done || s.cancelled {
		s.mu.Unlock()
		return
	}
	s.cancelled = true
	process := s.process
	s.mu.Unlock()
	if process != nil {
		_ = terminateProcess(process)
	}
}

func (s *Session) syncBuffer(sender Transport, afterSequence int64) {
	if sender == nil {
		return
	}
	chunks := s.buffer.After(afterSequence)
	if len(chunks) == 0 {
		return
	}
	// A single chunk is capped so its worst-case JSON escaping still fits the
	// 256 KiB frame limit. Sending one per sync frame keeps that bound explicit.
	for _, chunk := range chunks {
		if err := sender.Send("job.buffer.sync", protocol.BufferSync{
			JobID:  s.request.JobID,
			Chunks: []protocol.OutputChunk{chunk},
		}); err != nil {
			return
		}
	}
}

func (s *Session) reconcile(sender Transport) {
	if sender == nil {
		return
	}
	s.mu.RLock()
	done := s.done
	status := s.status
	pid := s.pid
	exitCode := s.exitCode
	failure := s.failure
	s.mu.RUnlock()
	if !done {
		_ = sender.Send("job.started", protocol.JobStarted{JobID: s.request.JobID, PID: pid})
		_ = sender.Send("job.status", protocol.JobStatus{JobID: s.request.JobID, Status: status})
		return
	}
	switch status {
	case "completed":
		if exitCode != nil {
			_ = sender.Send("job.completed", protocol.JobCompleted{JobID: s.request.JobID, ExitCode: *exitCode})
		}
	case "failed":
		_ = sender.Send("job.failed", protocol.JobFailed{JobID: s.request.JobID, Error: failure, ExitCode: exitCode})
	case "cancelled":
		_ = sender.Send("job.cancelled", protocol.JobReference{JobID: s.request.JobID})
	}
}

func (s *Session) currentStatus() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.status
}

func safeError(err error) string {
	if err == nil {
		return "unknown error"
	}
	message := strings.ToValidUTF8(err.Error(), "\uFFFD")
	if len(message) > maximumErrorBytes {
		message = message[:maximumErrorBytes]
	}
	return message
}

func safeDetail(err error) string {
	detail := safeError(err)
	if len(detail) > 1000 {
		detail = detail[:1000]
	}
	return detail
}
