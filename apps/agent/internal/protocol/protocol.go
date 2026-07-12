package protocol

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
)

const (
	Version                 = 1
	MaxMessageBytes         = 256 * 1024
	MaxCommandBytes         = 16 * 1024
	MaxOutputDataBytes      = 64 * 1024
	MaxInputDataBytes       = 64 * 1024
	MaxOutputChunksPerSync  = 1000
	MaximumRunningJobIDs    = 100
	MaximumShellArguments   = 20
	MaximumInheritedEnvVars = 100
)

type Envelope struct {
	Version   int             `json:"version"`
	Type      string          `json:"type"`
	RequestID string          `json:"requestId"`
	Timestamp string          `json:"timestamp"`
	Payload   json.RawMessage `json:"payload"`
}

type OutgoingEnvelope struct {
	Version   int    `json:"version"`
	Type      string `json:"type"`
	RequestID string `json:"requestId"`
	Timestamp string `json:"timestamp"`
	Payload   any    `json:"payload"`
}

type ServerMessage struct {
	Envelope
	Value any
}

type Welcome struct {
	DeviceID          string `json:"deviceId"`
	HeartbeatInterval int    `json:"heartbeatIntervalMs"`
	ServerTime        string `json:"serverTime"`
}

type RepositoryValidate struct {
	RepositoryID string `json:"repositoryId"`
	AbsolutePath string `json:"absolutePath"`
}

type JobStart struct {
	JobID                string   `json:"jobId"`
	RepositoryID         string   `json:"repositoryId"`
	RepositoryPath       string   `json:"repositoryPath"`
	Command              string   `json:"command"`
	WorkingDirectory     string   `json:"workingDirectory"`
	Interactive          bool     `json:"interactive"`
	Persistent           bool     `json:"persistent"`
	Shell                string   `json:"shell"`
	ShellArgs            []string `json:"shellArgs"`
	InheritedEnvironment []string `json:"inheritedEnvironment"`
	Columns              int      `json:"columns"`
	Rows                 int      `json:"rows"`
}

type JobInput struct {
	JobID         string `json:"jobId"`
	InputSequence int64  `json:"inputSequence"`
	Data          string `json:"data"`
}

type JobResize struct {
	JobID   string `json:"jobId"`
	Columns int    `json:"columns"`
	Rows    int    `json:"rows"`
}

type JobReference struct {
	JobID string `json:"jobId"`
}

type BufferRequest struct {
	JobID         string `json:"jobId"`
	AfterSequence int64  `json:"afterSequence"`
}

type Hello struct {
	DeviceID        string   `json:"deviceId"`
	Name            string   `json:"name"`
	Platform        string   `json:"platform"`
	Architecture    string   `json:"architecture"`
	AgentVersion    string   `json:"agentVersion"`
	ProtocolVersion []int    `json:"protocolVersions"`
	RunningJobIDs   []string `json:"runningJobIds"`
}

type DeviceReference struct {
	DeviceID string `json:"deviceId"`
}

type AgentStatus struct {
	DeviceID string `json:"deviceId"`
	Status   string `json:"status"`
	Detail   string `json:"detail,omitempty"`
}

type RepositoryValidationResult struct {
	RepositoryID    string `json:"repositoryId"`
	Valid           bool   `json:"valid"`
	CanonicalPath   string `json:"canonicalPath,omitempty"`
	RepositoryRoot  string `json:"repositoryRoot,omitempty"`
	IsGitRepository bool   `json:"isGitRepository"`
	Branch          string `json:"branch,omitempty"`
	Error           string `json:"error,omitempty"`
}

type JobStarted struct {
	JobID string `json:"jobId"`
	PID   int    `json:"pid,omitempty"`
}

type JobOutput struct {
	JobID    string `json:"jobId"`
	Sequence int64  `json:"sequence"`
	Stream   string `json:"stream"`
	Data     string `json:"data"`
}

type JobStatus struct {
	JobID  string `json:"jobId"`
	Status string `json:"status"`
	Detail string `json:"detail,omitempty"`
}

type JobCompleted struct {
	JobID    string `json:"jobId"`
	ExitCode int    `json:"exitCode"`
}

type JobFailed struct {
	JobID    string `json:"jobId"`
	Error    string `json:"error"`
	ExitCode *int   `json:"exitCode,omitempty"`
}

type InputAcknowledged struct {
	JobID         string `json:"jobId"`
	InputSequence int64  `json:"inputSequence"`
}

type OutputChunk struct {
	Sequence int64  `json:"sequence"`
	Stream   string `json:"stream"`
	Data     string `json:"data"`
}

type BufferSync struct {
	JobID  string        `json:"jobId"`
	Chunks []OutputChunk `json:"chunks"`
}

func NewMessage(messageType string, payload any) OutgoingEnvelope {
	return OutgoingEnvelope{
		Version:   Version,
		Type:      messageType,
		RequestID: uuid.NewString(),
		Timestamp: time.Now().UTC().Format(time.RFC3339Nano),
		Payload:   payload,
	}
}

func DecodeServerMessage(data []byte) (ServerMessage, error) {
	if len(data) == 0 || len(data) > MaxMessageBytes {
		return ServerMessage{}, fmt.Errorf("protocol message size must be between 1 and %d bytes", MaxMessageBytes)
	}

	var envelope Envelope
	if err := decodeStrict(data, &envelope); err != nil {
		return ServerMessage{}, fmt.Errorf("decode protocol envelope: %w", err)
	}
	if envelope.Version != Version {
		return ServerMessage{}, fmt.Errorf("unsupported protocol version %d", envelope.Version)
	}
	if _, err := uuid.Parse(envelope.RequestID); err != nil {
		return ServerMessage{}, fmt.Errorf("invalid request ID: %w", err)
	}
	if _, err := time.Parse(time.RFC3339, envelope.Timestamp); err != nil {
		return ServerMessage{}, fmt.Errorf("invalid message timestamp: %w", err)
	}
	if len(envelope.Payload) == 0 || bytes.Equal(envelope.Payload, []byte("null")) {
		return ServerMessage{}, errors.New("protocol payload is required")
	}

	var value any
	switch envelope.Type {
	case "agent.welcome":
		payload := Welcome{}
		if err := requireFields(envelope.Payload, "deviceId", "heartbeatIntervalMs", "serverTime"); err != nil {
			return ServerMessage{}, payloadError(envelope.Type, err)
		}
		if err := decodeStrict(envelope.Payload, &payload); err != nil {
			return ServerMessage{}, payloadError(envelope.Type, err)
		}
		if err := validateUUID(payload.DeviceID, "deviceId"); err != nil {
			return ServerMessage{}, err
		}
		if payload.HeartbeatInterval < 1000 || payload.HeartbeatInterval > 24*60*60*1000 {
			return ServerMessage{}, errors.New("heartbeatIntervalMs must be between 1000 and 86400000")
		}
		if _, err := time.Parse(time.RFC3339, payload.ServerTime); err != nil {
			return ServerMessage{}, fmt.Errorf("invalid serverTime: %w", err)
		}
		value = payload
	case "repository.validate":
		payload := RepositoryValidate{}
		if err := requireFields(envelope.Payload, "repositoryId", "absolutePath"); err != nil {
			return ServerMessage{}, payloadError(envelope.Type, err)
		}
		if err := decodeStrict(envelope.Payload, &payload); err != nil {
			return ServerMessage{}, payloadError(envelope.Type, err)
		}
		if err := validateUUID(payload.RepositoryID, "repositoryId"); err != nil {
			return ServerMessage{}, err
		}
		if err := validateString(payload.AbsolutePath, "absolutePath", 1, 4096); err != nil {
			return ServerMessage{}, err
		}
		value = payload
	case "job.start":
		payload := JobStart{}
		if err := requireFields(
			envelope.Payload,
			"jobId",
			"repositoryId",
			"repositoryPath",
			"command",
			"workingDirectory",
			"interactive",
			"persistent",
			"shell",
			"shellArgs",
			"inheritedEnvironment",
			"columns",
			"rows",
		); err != nil {
			return ServerMessage{}, payloadError(envelope.Type, err)
		}
		if err := decodeStrict(envelope.Payload, &payload); err != nil {
			return ServerMessage{}, payloadError(envelope.Type, err)
		}
		if err := validateJobStart(payload); err != nil {
			return ServerMessage{}, err
		}
		value = payload
	case "job.input":
		payload := JobInput{}
		if err := requireFields(envelope.Payload, "jobId", "inputSequence", "data"); err != nil {
			return ServerMessage{}, payloadError(envelope.Type, err)
		}
		if err := decodeStrict(envelope.Payload, &payload); err != nil {
			return ServerMessage{}, payloadError(envelope.Type, err)
		}
		if err := validateUUID(payload.JobID, "jobId"); err != nil {
			return ServerMessage{}, err
		}
		if payload.InputSequence < 0 {
			return ServerMessage{}, errors.New("inputSequence must be non-negative")
		}
		if len(payload.Data) > MaxInputDataBytes || !utf8.ValidString(payload.Data) {
			return ServerMessage{}, fmt.Errorf("input data must be valid UTF-8 and at most %d bytes", MaxInputDataBytes)
		}
		value = payload
	case "job.resize":
		payload := JobResize{}
		if err := requireFields(envelope.Payload, "jobId", "columns", "rows"); err != nil {
			return ServerMessage{}, payloadError(envelope.Type, err)
		}
		if err := decodeStrict(envelope.Payload, &payload); err != nil {
			return ServerMessage{}, payloadError(envelope.Type, err)
		}
		if err := validateUUID(payload.JobID, "jobId"); err != nil {
			return ServerMessage{}, err
		}
		if err := validateDimensions(payload.Columns, payload.Rows); err != nil {
			return ServerMessage{}, err
		}
		value = payload
	case "job.cancel":
		payload := JobReference{}
		if err := requireFields(envelope.Payload, "jobId"); err != nil {
			return ServerMessage{}, payloadError(envelope.Type, err)
		}
		if err := decodeStrict(envelope.Payload, &payload); err != nil {
			return ServerMessage{}, payloadError(envelope.Type, err)
		}
		if err := validateUUID(payload.JobID, "jobId"); err != nil {
			return ServerMessage{}, err
		}
		value = payload
	case "job.buffer.request":
		payload := BufferRequest{}
		if err := requireFields(envelope.Payload, "jobId", "afterSequence"); err != nil {
			return ServerMessage{}, payloadError(envelope.Type, err)
		}
		if err := decodeStrict(envelope.Payload, &payload); err != nil {
			return ServerMessage{}, payloadError(envelope.Type, err)
		}
		if err := validateUUID(payload.JobID, "jobId"); err != nil {
			return ServerMessage{}, err
		}
		if payload.AfterSequence < -1 {
			return ServerMessage{}, errors.New("afterSequence must be at least -1")
		}
		value = payload
	default:
		return ServerMessage{}, fmt.Errorf("unsupported server message type %q", envelope.Type)
	}
	return ServerMessage{Envelope: envelope, Value: value}, nil
}

func validateJobStart(payload JobStart) error {
	if err := validateUUID(payload.JobID, "jobId"); err != nil {
		return err
	}
	if err := validateUUID(payload.RepositoryID, "repositoryId"); err != nil {
		return err
	}
	if err := validateString(payload.RepositoryPath, "repositoryPath", 1, 4096); err != nil {
		return err
	}
	if err := validateString(payload.Command, "command", 1, MaxCommandBytes); err != nil {
		return err
	}
	if err := validateString(payload.WorkingDirectory, "workingDirectory", 0, 4096); err != nil {
		return err
	}
	if err := validateString(payload.Shell, "shell", 1, 4096); err != nil {
		return err
	}
	if len(payload.ShellArgs) > MaximumShellArguments {
		return fmt.Errorf("shellArgs may contain at most %d values", MaximumShellArguments)
	}
	for _, argument := range payload.ShellArgs {
		if err := validateString(argument, "shell argument", 0, 1000); err != nil {
			return err
		}
	}
	if len(payload.InheritedEnvironment) > MaximumInheritedEnvVars {
		return fmt.Errorf("inheritedEnvironment may contain at most %d values", MaximumInheritedEnvVars)
	}
	for _, name := range payload.InheritedEnvironment {
		if len(name) == 0 || len(name) > 200 || strings.ContainsAny(name, "=\x00") {
			return fmt.Errorf("invalid inherited environment name %q", name)
		}
	}
	return validateDimensions(payload.Columns, payload.Rows)
}

func validateDimensions(columns, rows int) error {
	if columns < 10 || columns > 1000 {
		return errors.New("columns must be between 10 and 1000")
	}
	if rows < 2 || rows > 1000 {
		return errors.New("rows must be between 2 and 1000")
	}
	return nil
}

func validateString(value, field string, minimum, maximum int) error {
	if !utf8.ValidString(value) || len(value) < minimum || len(value) > maximum || strings.ContainsRune(value, '\x00') {
		return fmt.Errorf("%s must be valid UTF-8, contain no NUL, and contain %d to %d bytes", field, minimum, maximum)
	}
	return nil
}

func validateUUID(value, field string) error {
	if _, err := uuid.Parse(value); err != nil {
		return fmt.Errorf("invalid %s: %w", field, err)
	}
	return nil
}

func payloadError(messageType string, err error) error {
	return fmt.Errorf("decode %s payload: %w", messageType, err)
}

func decodeStrict(data []byte, destination any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("multiple JSON values are not allowed")
		}
		return err
	}
	return nil
}

func requireFields(data []byte, fields ...string) error {
	var object map[string]json.RawMessage
	if err := json.Unmarshal(data, &object); err != nil {
		return err
	}
	for _, field := range fields {
		value, found := object[field]
		if !found || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return fmt.Errorf("required field %s is missing or null", field)
		}
	}
	return nil
}
