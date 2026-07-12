package client

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
)

func TestPairUsesServerContract(t *testing.T) {
	deviceID := uuid.NewString()
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost || request.URL.Path != "/api/devices/pair" {
			t.Errorf("request = %s %s", request.Method, request.URL.Path)
		}
		if request.Header.Get("Content-Type") != "application/json" {
			t.Errorf("Content-Type = %q", request.Header.Get("Content-Type"))
		}
		var input pairRequest
		if err := json.NewDecoder(request.Body).Decode(&input); err != nil {
			t.Errorf("decode request: %v", err)
		}
		if input.Code != "ABCD-EFGH" || input.Name != "Laptop" || input.AgentVersion != "0.1.0" {
			t.Errorf("pair request = %#v", input)
		}
		response.Header().Set("Content-Type", "application/json")
		response.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(response).Encode(pairResponse{DeviceID: deviceID, Credential: "rdc_secret"})
	}))
	defer server.Close()

	cfg, err := Pair(context.Background(), PairOptions{
		Server:       server.URL,
		Code:         " ABCD-EFGH ",
		Name:         "Laptop",
		AgentVersion: "0.1.0",
	})
	if err != nil {
		t.Fatalf("Pair() error = %v", err)
	}
	if cfg.DeviceID != deviceID || cfg.Credential != "rdc_secret" || cfg.Server != server.URL {
		t.Fatalf("Pair() config = %#v", cfg)
	}
}

func TestPairReturnsSafeServerError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusBadRequest)
		_, _ = response.Write([]byte(`{"error":{"code":"PAIRING_CODE_INVALID","message":"expired"}}`))
	}))
	defer server.Close()
	_, err := Pair(context.Background(), PairOptions{
		Server:       server.URL,
		Code:         "ABCD-EFGH",
		Name:         "Laptop",
		AgentVersion: "0.1.0",
	})
	if err == nil || err.Error() != "pairing rejected (400 Bad Request): expired" {
		t.Fatalf("Pair() error = %v", err)
	}
}
