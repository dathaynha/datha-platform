// Package events publishes the durable record of a call to JetStream. Live
// frames ride core NATS and are allowed to be lost; these are the record, so
// they go to the EVENTS stream that platform-nats owns.
package events

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/nats-io/nats.go"
)

// ServiceName is the envelope `service` field for this repo.
const ServiceName = "realtime-service"

// Event types, in envelope form. `started` fires when a call is answered, not
// when it is dialled: an invite nobody picks up produces `missed` instead, so
// history has no half-open rows.
const (
	TypeCallStarted = "messenger.call.started"
	TypeCallEnded   = "messenger.call.ended"
	TypeCallMissed  = "messenger.call.missed"
)

// Subject is the JetStream subject for an envelope type. The EVENTS stream
// already carries `events.messenger.>`, so call events need no topology change
// — only the messenger-service-calls durable does.
func Subject(eventType string) string { return "events." + eventType }

// publisher is the JetStream surface used here, kept narrow so tests need no
// broker.
type publisher interface {
	Publish(subj string, data []byte, opts ...nats.PubOpt) (*nats.PubAck, error)
}

// Publisher emits call events. It is nil-safe: with NATS unavailable the socket
// still works and calls still connect, they just leave no history.
type Publisher struct {
	js  publisher
	now func() time.Time
}

// NewPublisher wraps a JetStream context. A nil context yields a nil Publisher,
// which every method tolerates.
func NewPublisher(js nats.JetStreamContext) *Publisher {
	if js == nil {
		return nil
	}
	return &Publisher{js: js, now: time.Now}
}

// CallEvent describes one call for the record.
type CallEvent struct {
	CallID         string
	ConversationID string
	CallerID       string
	CalleeID       string   // 1:1 only; a group call carries ParticipantIDs instead
	ParticipantIDs []string // everyone invited — who was rung
	JoinedIDs      []string // everyone who joined at any point — who was actually on the call
	// MissedOwnerID names the one person a `missed` event is about, for a group
	// call where there is no callee. One event is published per person who did
	// not answer, because a bell rings for a person and "the group missed it" is
	// not something anyone can be told.
	MissedOwnerID   string
	Media           string // audio|video, as the call was set up
	Reason          string // ended/missed only
	StartedAt       time.Time
	AnsweredAt      time.Time
	DurationSeconds int
}

type envelope struct {
	ID            string         `json:"id"`
	Type          string         `json:"type"`
	Service       string         `json:"service"`
	EntityID      string         `json:"entity_id"`
	OwnerID       string         `json:"owner_id"`
	CorrelationID string         `json:"correlation_id"`
	Timestamp     string         `json:"timestamp"`
	Payload       map[string]any `json:"payload"`
}

// Publish emits one call event.
//
// `entity_id` is the call, so a projection can key on it while the event still
// attributes to a person like every other platform event. `correlation_id` is
// the call id: every event of one call then correlates without a request
// header, which a socket frame does not have.
//
// `owner_id` is the person the event is *about*, which is not the same person
// for every type. `started` and `ended` are "the call happened" facts and
// attribute to the caller; `missed` means "this person did not answer", so it
// attributes to the **callee**. notification-service turns `owner_id` into
// whose bell rings, so getting this wrong would tell the caller that they
// missed their own call.
//
// A group call has no callee, so a missed one is published **once per person
// who did not answer**, each naming that person. Before this, such an event
// carried an empty `owner_id` and notification-service skipped it outright —
// not a bad row, but nobody's bell rang at all.
func (p *Publisher) Publish(eventType string, e CallEvent) error {
	if p == nil || p.js == nil {
		return nil
	}

	payload := map[string]any{
		"call_id":         e.CallID,
		"conversation_id": e.ConversationID,
		"caller_id":       e.CallerID,
		"media":           e.Media,
		"started_at":      utcISO(e.StartedAt),
	}
	// A group call has no callee, and the field is deliberately left out rather
	// than sent empty: messenger-service's projection ignores an event with no
	// `callee_id`, so a group call writes no history row until the
	// `call_participants` projection exists (phase 3 slice 2). Sending an empty
	// string instead would make it write a row attributing the whole call to
	// nobody, which is worse than no row.
	if e.CalleeID != "" {
		payload["callee_id"] = e.CalleeID
	}
	if len(e.ParticipantIDs) > 0 {
		payload["participant_ids"] = e.ParticipantIDs
		// Sent alongside, and **even when empty**: a call nobody answered has an
		// empty joined set, and that is a fact the projection needs rather than
		// an absent field it would have to guess about.
		payload["joined_ids"] = e.JoinedIDs
	}
	if e.MissedOwnerID != "" {
		payload["missed_owner_id"] = e.MissedOwnerID
	}
	if !e.AnsweredAt.IsZero() {
		payload["answered_at"] = utcISO(e.AnsweredAt)
	}
	if e.Reason != "" {
		payload["reason"] = e.Reason
	}
	if eventType != TypeCallStarted {
		payload["duration_seconds"] = e.DurationSeconds
	}

	// `owner_id` is whose bell rings. For a 1:1 missed call that is the callee;
	// for a group there is none, so the publisher names one person per event.
	owner := e.CallerID
	if eventType == TypeCallMissed {
		owner = e.CalleeID
		if e.MissedOwnerID != "" {
			owner = e.MissedOwnerID
		}
	}

	data, err := json.Marshal(envelope{
		ID:            uuid.NewString(),
		Type:          eventType,
		Service:       ServiceName,
		EntityID:      e.CallID,
		OwnerID:       owner,
		CorrelationID: e.CallID,
		Timestamp:     utcISO(p.now().UTC()),
		Payload:       payload,
	})
	if err != nil {
		return fmt.Errorf("encode %s envelope: %w", eventType, err)
	}
	if _, err := p.js.Publish(Subject(eventType), data); err != nil {
		return fmt.Errorf("publish %s: %w", eventType, err)
	}
	return nil
}

func utcISO(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}
