package hub

import (
	"fmt"

	"github.com/nats-io/nats.go"
)

// NATSBus adapts a core-NATS connection to Bus. Core, not JetStream, on
// purpose: see the Bus doc comment.
type NATSBus struct {
	conn *nats.Conn
}

// NewNATSBus wraps a live NATS connection.
func NewNATSBus(conn *nats.Conn) *NATSBus { return &NATSBus{conn: conn} }

// Subscribe registers an async handler for a subject.
func (b *NATSBus) Subscribe(subject string, handler func(data []byte)) (Subscription, error) {
	sub, err := b.conn.Subscribe(subject, func(msg *nats.Msg) {
		handler(msg.Data)
	})
	if err != nil {
		return nil, fmt.Errorf("nats subscribe %s: %w", subject, err)
	}
	return sub, nil
}

// Publish sends one frame.
func (b *NATSBus) Publish(subject string, data []byte) error {
	if err := b.conn.Publish(subject, data); err != nil {
		return fmt.Errorf("nats publish %s: %w", subject, err)
	}
	return nil
}
