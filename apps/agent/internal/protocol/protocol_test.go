package protocol

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestDecodeServerMessageValidatesJobStart(t *testing.T) {
	message := NewMessage("job.start", JobStart{
		JobID:                uuid.NewString(),
		RepositoryID:         uuid.NewString(),
		RepositoryPath:       "/tmp/repository",
		Command:              "git status",
		WorkingDirectory:     ".",
		Shell:                "/bin/sh",
		ShellArgs:            []string{"-lc"},
		InheritedEnvironment: []string{"PATH"},
		Columns:              80,
		Rows:                 24,
	})
	data, err := json.Marshal(message)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := DecodeServerMessage(data)
	if err != nil {
		t.Fatalf("DecodeServerMessage() error = %v", err)
	}
	if _, ok := decoded.Value.(JobStart); !ok {
		t.Fatalf("decoded payload type = %T", decoded.Value)
	}
}

func TestDecodeServerMessageRejectsUnknownFields(t *testing.T) {
	message := map[string]any{
		"version":   Version,
		"type":      "job.cancel",
		"requestId": uuid.NewString(),
		"timestamp": time.Now().UTC().Format(time.RFC3339Nano),
		"payload": map[string]any{
			"jobId": uuid.NewString(),
			"extra": true,
		},
	}
	data, _ := json.Marshal(message)
	if _, err := DecodeServerMessage(data); err == nil {
		t.Fatal("DecodeServerMessage() accepted an unknown payload field")
	}
}

func TestDecodeServerMessageRejectsMissingRequiredFalseBoolean(t *testing.T) {
	message := map[string]any{
		"version":   Version,
		"type":      "job.start",
		"requestId": uuid.NewString(),
		"timestamp": time.Now().UTC().Format(time.RFC3339Nano),
		"payload": map[string]any{
			"jobId":                uuid.NewString(),
			"repositoryId":         uuid.NewString(),
			"repositoryPath":       "/tmp/repository",
			"command":              "true",
			"workingDirectory":     ".",
			"persistent":           false,
			"shell":                "/bin/sh",
			"shellArgs":            []string{"-c"},
			"inheritedEnvironment": []string{},
			"columns":              80,
			"rows":                 24,
		},
	}
	data, _ := json.Marshal(message)
	if _, err := DecodeServerMessage(data); err == nil {
		t.Fatal("DecodeServerMessage() accepted job.start without interactive")
	}
}
