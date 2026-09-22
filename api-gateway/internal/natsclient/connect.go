package natsclient

import (
	"fmt"
	"log/slog"
	"strings"

	"github.com/nats-io/nats.go"

	"chatbot-playground/api-gateway/internal/events"
)

// ConnectOptional connects to NATS JetStream for event publish. Empty url → (nil, nil, nil).
// On failure returns (nil, nil, err) so the caller can log and continue without events.
func ConnectOptional(url string) (*events.Publisher, func(), error) {
	url = strings.TrimSpace(url)
	if url == "" {
		return nil, func() {}, nil
	}

	// Reconnect forever — the default 60 attempts gives up after ~2 min of
	// broker outage and silently drops all auth.login publishes afterwards.
	nc, err := nats.Connect(url, nats.MaxReconnects(-1))
	if err != nil {
		return nil, nil, fmt.Errorf("nats connect: %w", err)
	}

	js, err := nc.JetStream()
	if err != nil {
		nc.Close()
		return nil, nil, fmt.Errorf("nats jetstream: %w", err)
	}

	slog.Info("NATS JetStream connected (gateway auth.login publish)")
	return events.NewPublisher(js), func() { _ = nc.Drain() }, nil
}
