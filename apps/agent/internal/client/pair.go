package client

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"runtime"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/relaydock/relaydock/apps/agent/internal/config"
)

type PairOptions struct {
	Server       string
	Code         string
	Name         string
	AgentVersion string
	HTTPClient   *http.Client
}

type pairRequest struct {
	Code         string `json:"code"`
	Name         string `json:"name"`
	Platform     string `json:"platform"`
	Architecture string `json:"architecture"`
	AgentVersion string `json:"agentVersion"`
}

type pairResponse struct {
	DeviceID   string `json:"deviceId"`
	Credential string `json:"credential"`
}

type errorResponse struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func Pair(ctx context.Context, options PairOptions) (config.Config, error) {
	server, err := config.ParseServerURL(options.Server)
	if err != nil {
		return config.Config{}, err
	}
	code := strings.TrimSpace(options.Code)
	if code == "" || len(code) > 100 {
		return config.Config{}, errors.New("pairing code must contain 1 to 100 bytes")
	}
	name := strings.TrimSpace(options.Name)
	if name == "" || len(name) > 100 {
		return config.Config{}, errors.New("device name must contain 1 to 100 bytes")
	}
	payload, err := json.Marshal(pairRequest{
		Code:         code,
		Name:         name,
		Platform:     runtime.GOOS,
		Architecture: runtime.GOARCH,
		AgentVersion: options.AgentVersion,
	})
	if err != nil {
		return config.Config{}, fmt.Errorf("encode pairing request: %w", err)
	}
	endpoint, err := config.Endpoint(server.String(), "/api/devices/pair")
	if err != nil {
		return config.Config{}, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return config.Config{}, fmt.Errorf("create pairing request: %w", err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	client := options.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second}
	}
	response, err := client.Do(request)
	if err != nil {
		return config.Config{}, fmt.Errorf("pair with RelayDock server: %w", err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 1024*1024))
	if err != nil {
		return config.Config{}, fmt.Errorf("read pairing response: %w", err)
	}
	if response.StatusCode != http.StatusCreated {
		var serverError errorResponse
		if json.Unmarshal(body, &serverError) == nil && serverError.Error.Message != "" {
			return config.Config{}, fmt.Errorf("pairing rejected (%s): %s", response.Status, serverError.Error.Message)
		}
		return config.Config{}, fmt.Errorf("pairing rejected with HTTP status %s", response.Status)
	}
	var result pairResponse
	if err := json.Unmarshal(body, &result); err != nil {
		return config.Config{}, fmt.Errorf("decode pairing response: %w", err)
	}
	if _, err := uuid.Parse(result.DeviceID); err != nil {
		return config.Config{}, fmt.Errorf("server returned an invalid device ID: %w", err)
	}
	if len(result.Credential) == 0 || len(result.Credential) > 4096 || strings.IndexFunc(result.Credential, func(character rune) bool {
		return character < 0x21 || character > 0x7e
	}) >= 0 {
		return config.Config{}, errors.New("server returned an invalid device credential")
	}
	return config.Config{
		Server:             server.String(),
		DeviceID:           result.DeviceID,
		Credential:         result.Credential,
		DeviceName:         name,
		Repositories:       make(map[string]string),
		AllowedEnvironment: append([]string(nil), config.DefaultAllowedEnvironment...),
	}, nil
}
