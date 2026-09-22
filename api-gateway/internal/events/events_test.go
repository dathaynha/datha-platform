package events

import (
	"encoding/json"
	"testing"

	"github.com/nats-io/nats.go"
)

type fakeJetStream struct {
	subject string
	data    []byte
}

func (f *fakeJetStream) Publish(subj string, data []byte, _ ...nats.PubOpt) (*nats.PubAck, error) {
	f.subject = subj
	f.data = append([]byte(nil), data...)
	return &nats.PubAck{}, nil
}

func TestBuildAuthLoginEnvelope(t *testing.T) {
	env := buildAuthLoginEnvelope(AuthLoginParams{
		OwnerID:       "google_abc",
		CorrelationID: "corr-1",
		Provider:      "google",
		GrantType:     GrantAuthorization,
	})
	if env.Type != TypeAuthLogin {
		t.Fatalf("type: got %q want %q", env.Type, TypeAuthLogin)
	}
	if env.Service != ServiceName {
		t.Fatalf("service: got %q", env.Service)
	}
	if env.OwnerID != "google_abc" || env.EntityID != "google_abc" {
		t.Fatalf("owner/entity: %+v", env)
	}
	if env.Payload["provider"] != "google" {
		t.Fatalf("payload provider: %+v", env.Payload)
	}
}

func TestBuildAuthLoginEnvelopeEntraFields(t *testing.T) {
	env := buildAuthLoginEnvelope(AuthLoginParams{
		OwnerID:       "entra_oid",
		Provider:      "entra",
		GrantType:     GrantAuthorization,
		EntraTenantID: "tenant-1",
		EntraPool:     "organizations",
	})
	if env.Payload["entra_tenant_id"] != "tenant-1" {
		t.Fatalf("entra_tenant_id: %+v", env.Payload)
	}
	if env.Payload["entra_login_pool"] != "organizations" {
		t.Fatalf("entra_login_pool: %+v", env.Payload)
	}
}

func TestNewPublisherNil(t *testing.T) {
	if NewPublisher(nil) != nil {
		t.Fatal("expected nil publisher when JetStream is nil")
	}
}

func TestPublishAuthLoginSkipsRefresh(t *testing.T) {
	js := &fakeJetStream{}
	p := &Publisher{js: js}
	if err := p.PublishAuthLogin(AuthLoginParams{
		OwnerID:   "google_abc",
		Provider:  "google",
		GrantType: "refresh_token",
	}); err != nil {
		t.Fatal(err)
	}
	if js.subject != "" {
		t.Fatal("expected no publish for refresh_token grant")
	}
}

func TestPublishAuthLoginPublishesEnvelope(t *testing.T) {
	js := &fakeJetStream{}
	p := &Publisher{js: js}

	err := p.PublishAuthLogin(AuthLoginParams{
		OwnerID:       "google_abc",
		CorrelationID: "corr-99",
		Provider:      "google",
		GrantType:     GrantAuthorization,
	})
	if err != nil {
		t.Fatalf("PublishAuthLogin: %v", err)
	}
	if js.subject != SubjectAuthLogin {
		t.Fatalf("subject: got %q want %q", js.subject, SubjectAuthLogin)
	}

	var env platformEvent
	if err := json.Unmarshal(js.data, &env); err != nil {
		t.Fatalf("unmarshal envelope: %v", err)
	}
	if env.Type != TypeAuthLogin || env.OwnerID != "google_abc" {
		t.Fatalf("envelope: %+v", env)
	}
}
