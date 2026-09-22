package events

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"github.com/nats-io/nats.go"
)

const (
	// ServiceName is the event envelope service field for api-gateway.
	ServiceName = "api-gateway"
	// TypeAuthLogin is the platform event type for successful OAuth sign-in.
	TypeAuthLogin = "gateway.auth.login"
	// SubjectAuthLogin is the JetStream subject for login events.
	SubjectAuthLogin = "events.gateway.auth.login"
	// GrantAuthorization is the OAuth grant_type value that triggers login publish.
	GrantAuthorization = "authorization_code"
)

// jetStreamPublisher is the subset of JetStream used for login events (mockable in tests).
type jetStreamPublisher interface {
	Publish(subj string, data []byte, opts ...nats.PubOpt) (*nats.PubAck, error)
}

// Publisher publishes platform events to JetStream (nil-safe when NATS is unavailable).
type Publisher struct {
	js jetStreamPublisher
}

// NewPublisher wraps JetStream for login events; nil JS returns nil.
func NewPublisher(js nats.JetStreamContext) *Publisher {
	if js == nil {
		return nil
	}
	return &Publisher{js: js}
}

// AuthLoginParams describes a successful OAuth code exchange → internal JWT issued.
type AuthLoginParams struct {
	OwnerID       string
	CorrelationID string
	Provider      string // google | entra
	GrantType     string
	EntraTenantID string // optional; Entra id_token tid
	EntraPool     string // optional; organizations | consumers
}

type platformEvent struct {
	ID            string         `json:"id"`
	Type          string         `json:"type"`
	Service       string         `json:"service"`
	EntityID      string         `json:"entity_id"`
	OwnerID       string         `json:"owner_id"`
	CorrelationID string         `json:"correlation_id"`
	Timestamp     string         `json:"timestamp"`
	Payload       map[string]any `json:"payload"`
}

func utcISO() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
}

func buildAuthLoginEnvelope(p AuthLoginParams) platformEvent {
	payload := map[string]any{
		"provider":   p.Provider,
		"grant_type": p.GrantType,
	}
	if p.EntraTenantID != "" {
		payload["entra_tenant_id"] = p.EntraTenantID
	}
	if p.EntraPool != "" {
		payload["entra_login_pool"] = p.EntraPool
	}
	return platformEvent{
		ID:            uuid.NewString(),
		Type:          TypeAuthLogin,
		Service:       ServiceName,
		EntityID:      p.OwnerID,
		OwnerID:       p.OwnerID,
		CorrelationID: p.CorrelationID,
		Timestamp:     utcISO(),
		Payload:       payload,
	}
}

// PublishAuthLogin emits events.gateway.auth.login (best-effort; no error if publisher nil).
func (p *Publisher) PublishAuthLogin(params AuthLoginParams) error {
	if p == nil || p.js == nil {
		return nil
	}
	if params.GrantType != GrantAuthorization {
		return nil
	}
	envelope := buildAuthLoginEnvelope(params)
	data, err := json.Marshal(envelope)
	if err != nil {
		return err
	}
	_, err = p.js.Publish(SubjectAuthLogin, data)
	return err
}
