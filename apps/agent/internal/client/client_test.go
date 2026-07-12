package client

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/relaydock/relaydock/apps/agent/internal/config"
	"github.com/relaydock/relaydock/apps/agent/internal/protocol"
	"github.com/relaydock/relaydock/apps/agent/internal/repository"
	"github.com/relaydock/relaydock/apps/agent/internal/session"
)

func TestClientAuthenticatesAndSendsHelloFirst(t *testing.T) {
	deviceID := uuid.NewString()
	credential := "rdc_test_credential"
	observed := make(chan error, 1)
	upgrader := websocket.Upgrader{CheckOrigin: func(_ *http.Request) bool { return true }}
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/ws/agent" {
			observed <- fmt.Errorf("path = %q", request.URL.Path)
			return
		}
		if request.Header.Get("Authorization") != "Bearer "+credential {
			observed <- fmt.Errorf("Authorization header is incorrect")
			return
		}
		connection, err := upgrader.Upgrade(response, request, nil)
		if err != nil {
			observed <- err
			return
		}
		defer connection.Close()
		_, data, err := connection.ReadMessage()
		if err != nil {
			observed <- err
			return
		}
		var hello protocol.OutgoingEnvelope
		if err := json.Unmarshal(data, &hello); err != nil {
			observed <- err
			return
		}
		if hello.Type != "agent.hello" {
			observed <- fmt.Errorf("first frame type = %q", hello.Type)
			return
		}
		welcome := protocol.NewMessage("agent.welcome", protocol.Welcome{
			DeviceID:          deviceID,
			HeartbeatInterval: 1000,
			ServerTime:        time.Now().UTC().Format(time.RFC3339Nano),
		})
		if err := connection.WriteJSON(welcome); err != nil {
			observed <- err
			return
		}
		_, data, err = connection.ReadMessage()
		if err != nil {
			observed <- err
			return
		}
		var status protocol.OutgoingEnvelope
		if err := json.Unmarshal(data, &status); err != nil {
			observed <- err
			return
		}
		if status.Type != "agent.status" {
			observed <- fmt.Errorf("second agent frame type = %q", status.Type)
			return
		}
		observed <- nil
		_, _, _ = connection.ReadMessage()
	}))
	defer server.Close()

	store := config.NewStore(filepath.Join(t.TempDir(), "agent.json"))
	cfg := config.Config{
		Server:             server.URL,
		DeviceID:           deviceID,
		Credential:         credential,
		DeviceName:         "test laptop",
		Repositories:       map[string]string{},
		AllowedEnvironment: append([]string(nil), config.DefaultAllowedEnvironment...),
	}
	if err := store.Set(cfg); err != nil {
		t.Fatal(err)
	}
	registry := repository.NewRegistry(nil)
	sessions := session.NewManager(registry, store.Snapshot)
	agent := New(store, registry, sessions, "0.1.0", log.New(io.Discard, "", 0))
	sessions.SetTransport(agent)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- agent.Run(ctx) }()
	select {
	case err := <-observed:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for agent handshake")
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Run() error = %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("agent did not stop after context cancellation")
	}
}
