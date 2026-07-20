//go:build !windows

package session

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/relaydock/relaydock/apps/agent/internal/config"
	"github.com/relaydock/relaydock/apps/agent/internal/protocol"
	"github.com/relaydock/relaydock/apps/agent/internal/repository"
)

type sentMessage struct {
	messageType string
	payload     any
}

type recordingTransport struct {
	mu       sync.Mutex
	messages []sentMessage
	notify   chan struct{}
}

func newRecordingTransport() *recordingTransport {
	return &recordingTransport{notify: make(chan struct{}, 100)}
}

func (r *recordingTransport) Send(messageType string, payload any) error {
	r.mu.Lock()
	r.messages = append(r.messages, sentMessage{messageType: messageType, payload: payload})
	r.mu.Unlock()
	select {
	case r.notify <- struct{}{}:
	default:
	}
	return nil
}

func (r *recordingTransport) waitFor(t *testing.T, messageType string) sentMessage {
	t.Helper()
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	for {
		r.mu.Lock()
		for _, message := range r.messages {
			if message.messageType == messageType {
				r.mu.Unlock()
				return message
			}
		}
		r.mu.Unlock()
		select {
		case <-r.notify:
		case <-deadline.C:
			t.Fatalf("timed out waiting for %s; messages = %#v", messageType, r.messages)
		}
	}
}

func TestManagerRunsNonInteractiveCommandAndSeparatesStreams(t *testing.T) {
	root := t.TempDir()
	repositoryID := uuid.NewString()
	registry := repository.NewRegistry(map[string]string{repositoryID: root})
	cfg := config.Config{AllowedEnvironment: []string{"PATH"}}
	manager := NewManager(registry, func() config.Config { return cfg })
	transport := newRecordingTransport()
	manager.SetTransport(transport)
	manager.Start(protocol.JobStart{
		JobID:            uuid.NewString(),
		RepositoryID:     repositoryID,
		RepositoryPath:   root,
		Command:          "printf stdout; printf stderr >&2",
		WorkingDirectory: ".",
		Shell:            "/bin/sh",
		ShellArgs:        []string{"-c"},
		Columns:          80,
		Rows:             24,
	})
	transport.waitFor(t, "job.completed")

	transport.mu.Lock()
	defer transport.mu.Unlock()
	streams := map[string]string{}
	for _, message := range transport.messages {
		if message.messageType == "job.output" {
			output := message.payload.(protocol.JobOutput)
			streams[output.Stream] += output.Data
		}
	}
	if streams["stdout"] != "stdout" || streams["stderr"] != "stderr" {
		t.Fatalf("output streams = %#v", streams)
	}
}

func TestManagerCoalescesOutputWithinFrameLimit(t *testing.T) {
	root := t.TempDir()
	repositoryID := uuid.NewString()
	registry := repository.NewRegistry(map[string]string{repositoryID: root})
	cfg := config.Config{AllowedEnvironment: []string{"PATH"}}
	manager := NewManager(registry, func() config.Config { return cfg })
	transport := newRecordingTransport()
	manager.SetTransport(transport)
	const total = 100000
	manager.Start(protocol.JobStart{
		JobID:            uuid.NewString(),
		RepositoryID:     repositoryID,
		RepositoryPath:   root,
		Command:          "awk 'BEGIN{for(i=0;i<100000;i++)printf \"A\"}'",
		WorkingDirectory: ".",
		Shell:            "/bin/sh",
		ShellArgs:        []string{"-c"},
		Columns:          80,
		Rows:             24,
	})
	transport.waitFor(t, "job.completed")

	transport.mu.Lock()
	defer transport.mu.Unlock()
	reassembled := 0
	for _, message := range transport.messages {
		if message.messageType != "job.output" {
			continue
		}
		output := message.payload.(protocol.JobOutput)
		// Every coalesced chunk must stay within the frame-safe cap so its JSON
		// encoding never exceeds the protocol message limit.
		if len(output.Data) > outputCoalesceBytes {
			t.Fatalf("chunk of %d bytes exceeds frame cap %d", len(output.Data), outputCoalesceBytes)
		}
		for index := 0; index < len(output.Data); index++ {
			if output.Data[index] != 'A' {
				t.Fatalf("unexpected byte %q at %d", output.Data[index], index)
			}
		}
		reassembled += len(output.Data)
	}
	// Coalescing must be lossless: the full stream is reassembled from the chunks.
	if reassembled != total {
		t.Fatalf("reassembled %d bytes; want %d", reassembled, total)
	}
}

func TestManagerInteractivePTYAcceptsInputAndCancellation(t *testing.T) {
	root := t.TempDir()
	repositoryID := uuid.NewString()
	jobID := uuid.NewString()
	registry := repository.NewRegistry(map[string]string{repositoryID: root})
	cfg := config.Config{AllowedEnvironment: []string{"PATH"}}
	manager := NewManager(registry, func() config.Config { return cfg })
	transport := newRecordingTransport()
	manager.SetTransport(transport)
	manager.Start(protocol.JobStart{
		JobID:            jobID,
		RepositoryID:     repositoryID,
		RepositoryPath:   root,
		Command:          "cat",
		WorkingDirectory: ".",
		Interactive:      true,
		Persistent:       true,
		Shell:            "/bin/sh",
		ShellArgs:        []string{"-c"},
		Columns:          80,
		Rows:             24,
	})
	transport.waitFor(t, "job.started")
	manager.Input(protocol.JobInput{JobID: jobID, InputSequence: 0, Data: "hello\n"})
	transport.waitFor(t, "job.input.acknowledged")
	manager.Resize(protocol.JobResize{JobID: jobID, Columns: 100, Rows: 30})
	manager.Cancel(jobID)
	transport.waitFor(t, "job.cancelled")

	shutdown, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := manager.Close(shutdown); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
}
