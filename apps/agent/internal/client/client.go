package client

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math/rand"
	"net/http"
	"runtime"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/relaydock/relaydock/apps/agent/internal/config"
	"github.com/relaydock/relaydock/apps/agent/internal/protocol"
	"github.com/relaydock/relaydock/apps/agent/internal/repository"
	"github.com/relaydock/relaydock/apps/agent/internal/session"
)

const (
	writeTimeout     = 10 * time.Second
	initialBackoff   = time.Second
	maximumBackoff   = 30 * time.Second
	stableConnection = 30 * time.Second
)

var ErrDisconnected = errors.New("agent websocket is not connected")

type Client struct {
	store    *config.Store
	registry *repository.Registry
	sessions *session.Manager
	version  string
	logger   *log.Logger
	dialer   *websocket.Dialer

	connectionMu sync.RWMutex
	connection   *websocket.Conn
	writeMu      sync.Mutex
	random       *rand.Rand
}

func New(store *config.Store, registry *repository.Registry, sessions *session.Manager, version string, logger *log.Logger) *Client {
	if logger == nil {
		logger = log.Default()
	}
	return &Client{
		store:    store,
		registry: registry,
		sessions: sessions,
		version:  version,
		logger:   logger,
		dialer: &websocket.Dialer{
			HandshakeTimeout:  15 * time.Second,
			Proxy:             http.ProxyFromEnvironment,
			EnableCompression: false,
		},
		random: rand.New(rand.NewSource(time.Now().UnixNano())),
	}
}

func (c *Client) Run(ctx context.Context) error {
	backoff := initialBackoff
	for {
		connectedFor, err := c.runConnection(ctx)
		if ctx.Err() != nil {
			return nil
		}
		if err != nil {
			c.logger.Printf("connection ended: %v", err)
		}
		if connectedFor >= stableConnection {
			backoff = initialBackoff
		}
		delay := c.jitter(backoff)
		c.logger.Printf("reconnecting in %s", delay.Round(time.Millisecond))
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil
		case <-timer.C:
		}
		if connectedFor < stableConnection && backoff < maximumBackoff {
			backoff *= 2
			if backoff > maximumBackoff {
				backoff = maximumBackoff
			}
		}
	}
}

func (c *Client) Send(messageType string, payload any) error {
	message := protocol.NewMessage(messageType, payload)
	data, err := json.Marshal(message)
	if err != nil {
		return fmt.Errorf("encode %s message: %w", messageType, err)
	}
	if len(data) > protocol.MaxMessageBytes {
		return fmt.Errorf("%s message is %d bytes; maximum is %d", messageType, len(data), protocol.MaxMessageBytes)
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	connection := c.currentConnection()
	if connection == nil {
		return ErrDisconnected
	}
	if err := connection.SetWriteDeadline(time.Now().Add(writeTimeout)); err != nil {
		return err
	}
	if err := connection.WriteMessage(websocket.TextMessage, data); err != nil {
		_ = connection.Close()
		return fmt.Errorf("write %s message: %w", messageType, err)
	}
	return nil
}

func (c *Client) runConnection(ctx context.Context) (time.Duration, error) {
	cfg := c.store.Snapshot()
	endpoint, err := config.WebSocketEndpoint(cfg.Server)
	if err != nil {
		return 0, err
	}
	headers := http.Header{}
	headers.Set("Authorization", "Bearer "+cfg.Credential)
	connection, response, err := c.dialer.DialContext(ctx, endpoint, headers)
	if err != nil {
		if response != nil {
			return 0, fmt.Errorf("websocket handshake failed with HTTP status %s: %w", response.Status, err)
		}
		return 0, fmt.Errorf("dial agent websocket: %w", err)
	}
	defer connection.Close()
	connection.SetReadLimit(protocol.MaxMessageBytes)
	connectionDone := make(chan struct{})
	defer close(connectionDone)
	go func() {
		select {
		case <-ctx.Done():
			_ = connection.Close()
		case <-connectionDone:
		}
	}()

	hello := protocol.NewMessage("agent.hello", protocol.Hello{
		DeviceID:        cfg.DeviceID,
		Name:            cfg.DeviceName,
		Platform:        runtime.GOOS,
		Architecture:    runtime.GOARCH,
		AgentVersion:    c.version,
		ProtocolVersion: []int{protocol.Version},
		RunningJobIDs:   c.sessions.RunningJobIDs(),
	})
	if err := writeInitial(connection, hello); err != nil {
		return 0, fmt.Errorf("send agent hello: %w", err)
	}
	if err := connection.SetReadDeadline(time.Now().Add(15 * time.Second)); err != nil {
		return 0, fmt.Errorf("set welcome deadline: %w", err)
	}
	messageType, data, err := connection.ReadMessage()
	if err != nil {
		return 0, fmt.Errorf("read agent welcome: %w", err)
	}
	if err := connection.SetReadDeadline(time.Time{}); err != nil {
		return 0, fmt.Errorf("clear welcome deadline: %w", err)
	}
	if messageType != websocket.TextMessage {
		return 0, errors.New("server welcome must be a text websocket frame")
	}
	message, err := protocol.DecodeServerMessage(data)
	if err != nil {
		return 0, fmt.Errorf("validate agent welcome: %w", err)
	}
	welcome, ok := message.Value.(protocol.Welcome)
	if !ok || message.Type != "agent.welcome" {
		return 0, fmt.Errorf("first server frame must be agent.welcome, received %q", message.Type)
	}
	if welcome.DeviceID != cfg.DeviceID {
		return 0, errors.New("server welcome device ID does not match local configuration")
	}

	connectedAt := time.Now()
	c.setConnection(connection)
	defer c.clearConnection(connection)
	c.logger.Printf("connected to RelayDock as device %s", cfg.DeviceID)
	heartbeatContext, cancelHeartbeat := context.WithCancel(ctx)
	defer cancelHeartbeat()
	go c.heartbeat(heartbeatContext, cfg.DeviceID, time.Duration(welcome.HeartbeatInterval)*time.Millisecond)
	_ = c.Send("agent.status", protocol.AgentStatus{DeviceID: cfg.DeviceID, Status: "online"})
	c.sessions.ReconcileAll()

	for {
		messageType, data, err = connection.ReadMessage()
		if err != nil {
			return time.Since(connectedAt), fmt.Errorf("read server message: %w", err)
		}
		if messageType != websocket.TextMessage {
			return time.Since(connectedAt), errors.New("server sent a non-text websocket frame")
		}
		message, err = protocol.DecodeServerMessage(data)
		if err != nil {
			return time.Since(connectedAt), fmt.Errorf("reject invalid server message: %w", err)
		}
		if err := c.handle(ctx, message); err != nil {
			return time.Since(connectedAt), err
		}
	}
}

func (c *Client) handle(ctx context.Context, message protocol.ServerMessage) error {
	switch payload := message.Value.(type) {
	case protocol.Welcome:
		return errors.New("received an unexpected duplicate agent.welcome")
	case protocol.RepositoryValidate:
		result := repository.ValidatePath(ctx, payload.AbsolutePath)
		if result.Valid {
			if err := c.store.RegisterRepository(payload.RepositoryID, result.CanonicalPath); err != nil {
				result.Valid = false
				result.Error = fmt.Sprintf("persist repository registration: %v", err)
				result.CanonicalPath = ""
				result.RepositoryRoot = ""
				result.IsGitRepository = false
				result.Branch = ""
			} else {
				c.registry.Register(payload.RepositoryID, result.CanonicalPath)
			}
		}
		return c.Send("repository.validation.result", protocol.RepositoryValidationResult{
			RepositoryID:    payload.RepositoryID,
			Valid:           result.Valid,
			CanonicalPath:   result.CanonicalPath,
			RepositoryRoot:  result.RepositoryRoot,
			IsGitRepository: result.IsGitRepository,
			Branch:          result.Branch,
			Error:           result.Error,
		})
	case protocol.JobStart:
		c.sessions.Start(payload)
	case protocol.JobInput:
		c.sessions.Input(payload)
	case protocol.JobResize:
		c.sessions.Resize(payload)
	case protocol.JobReference:
		c.sessions.Cancel(payload.JobID)
	case protocol.BufferRequest:
		c.sessions.Sync(payload.JobID, payload.AfterSequence)
	default:
		return fmt.Errorf("unhandled server message payload %T", payload)
	}
	return nil
}

func (c *Client) heartbeat(ctx context.Context, deviceID string, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := c.Send("agent.heartbeat", protocol.DeviceReference{DeviceID: deviceID}); err != nil {
				return
			}
		}
	}
}

func (c *Client) setConnection(connection *websocket.Conn) {
	c.connectionMu.Lock()
	defer c.connectionMu.Unlock()
	c.connection = connection
}

func (c *Client) clearConnection(connection *websocket.Conn) {
	c.connectionMu.Lock()
	defer c.connectionMu.Unlock()
	if c.connection == connection {
		c.connection = nil
	}
}

func (c *Client) currentConnection() *websocket.Conn {
	c.connectionMu.RLock()
	defer c.connectionMu.RUnlock()
	return c.connection
}

func (c *Client) jitter(backoff time.Duration) time.Duration {
	factor := 0.8 + c.random.Float64()*0.4
	return time.Duration(float64(backoff) * factor)
}

func writeInitial(connection *websocket.Conn, message protocol.OutgoingEnvelope) error {
	data, err := json.Marshal(message)
	if err != nil {
		return err
	}
	if len(data) > protocol.MaxMessageBytes {
		return errors.New("agent hello exceeds maximum protocol message size")
	}
	if err := connection.SetWriteDeadline(time.Now().Add(writeTimeout)); err != nil {
		return err
	}
	return connection.WriteMessage(websocket.TextMessage, data)
}
