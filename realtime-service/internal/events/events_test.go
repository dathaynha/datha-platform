package events

import (
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
)

type recordingJS struct {
	subjects []string
	bodies   [][]byte
	err      error
}

func (r *recordingJS) Publish(subj string, data []byte, _ ...nats.PubOpt) (*nats.PubAck, error) {
	if r.err != nil {
		return nil, r.err
	}
	r.subjects = append(r.subjects, subj)
	r.bodies = append(r.bodies, data)
	return &nats.PubAck{}, nil
}

func newTestPublisher(js *recordingJS) *Publisher {
	return &Publisher{js: js, now: func() time.Time { return time.Unix(1700000000, 0).UTC() }}
}

func sampleCall() CallEvent {
	started := time.Unix(1699999900, 0).UTC()
	return CallEvent{
		CallID:          "call-1",
		ConversationID:  "conv-1",
		CallerID:        "google_1",
		CalleeID:        "google_2",
		StartedAt:       started,
		AnsweredAt:      started.Add(5 * time.Second),
		DurationSeconds: 42,
	}
}

func decodeOnly(t *testing.T, data []byte) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.Unmarshal(data, &body); err != nil {
		t.Fatalf("decode envelope: %v", err)
	}
	return body
}

func TestSubjectsLandUnderTheStreamsMessengerPrefix(t *testing.T) {
	// EVENTS already carries events.messenger.> — that is why call events need
	// no stream change, only the messenger-service-calls durable.
	for _, eventType := range []string{TypeCallStarted, TypeCallEnded, TypeCallMissed} {
		if got := Subject(eventType); got != "events."+eventType {
			t.Fatalf("Subject(%q) = %q", eventType, got)
		}
		if len(eventType) < len("messenger.call.") || eventType[:len("messenger.call.")] != "messenger.call." {
			t.Fatalf("event type %q is outside the messenger.call namespace", eventType)
		}
	}
}

func TestPublishWritesTheStandardEnvelope(t *testing.T) {
	js := &recordingJS{}
	if err := newTestPublisher(js).Publish(TypeCallStarted, sampleCall()); err != nil {
		t.Fatalf("Publish: %v", err)
	}
	if len(js.subjects) != 1 || js.subjects[0] != "events.messenger.call.started" {
		t.Fatalf("subjects = %v", js.subjects)
	}

	body := decodeOnly(t, js.bodies[0])
	for field, want := range map[string]any{
		"type":    TypeCallStarted,
		"service": ServiceName,
		// entity_id is the call so a projection can key on it; owner_id is the
		// caller so the event still attributes to a person.
		"entity_id": "call-1",
		"owner_id":  "google_1",
		// A socket frame carries no request header, so the call correlates
		// every event of one call with itself.
		"correlation_id": "call-1",
		"timestamp":      "2023-11-14T22:13:20.000Z",
	} {
		if body[field] != want {
			t.Fatalf("%s = %v, want %v", field, body[field], want)
		}
	}
	if body["id"] == "" || body["id"] == nil {
		t.Fatal("envelope has no id")
	}
}

func TestStartedCarriesNoDurationButEndedDoes(t *testing.T) {
	js := &recordingJS{}
	publisher := newTestPublisher(js)
	if err := publisher.Publish(TypeCallStarted, sampleCall()); err != nil {
		t.Fatalf("Publish started: %v", err)
	}
	ended := sampleCall()
	ended.Reason = "hangup"
	if err := publisher.Publish(TypeCallEnded, ended); err != nil {
		t.Fatalf("Publish ended: %v", err)
	}

	started := decodeOnly(t, js.bodies[0])["payload"].(map[string]any)
	if _, present := started["duration_seconds"]; present {
		t.Fatal("a call that has just started has no duration")
	}
	if _, present := started["reason"]; present {
		t.Fatal("started carries no reason")
	}

	finished := decodeOnly(t, js.bodies[1])["payload"].(map[string]any)
	if finished["duration_seconds"] != float64(42) {
		t.Fatalf("duration_seconds = %v, want 42", finished["duration_seconds"])
	}
	if finished["reason"] != "hangup" {
		t.Fatalf("reason = %v", finished["reason"])
	}
	for _, field := range []string{"call_id", "conversation_id", "caller_id", "callee_id", "started_at", "answered_at"} {
		if finished[field] == nil {
			t.Fatalf("payload is missing %s — the projection needs it", field)
		}
	}
}

func TestMissedAttributesToTheCalleeNotTheCaller(t *testing.T) {
	// notification-service turns owner_id into whose bell rings. Attributing a
	// missed call to the caller would tell them they missed their own call.
	js := &recordingJS{}
	missed := sampleCall()
	missed.AnsweredAt = time.Time{}
	missed.Reason = "missed"

	publisher := newTestPublisher(js)
	if err := publisher.Publish(TypeCallMissed, missed); err != nil {
		t.Fatalf("Publish missed: %v", err)
	}
	if got := decodeOnly(t, js.bodies[0])["owner_id"]; got != "google_2" {
		t.Fatalf("missed owner_id = %v, want the callee", got)
	}

	// The other two are "the call happened" facts and stay with the caller.
	for _, eventType := range []string{TypeCallStarted, TypeCallEnded} {
		js.bodies = nil
		if err := publisher.Publish(eventType, sampleCall()); err != nil {
			t.Fatalf("Publish %s: %v", eventType, err)
		}
		if got := decodeOnly(t, js.bodies[0])["owner_id"]; got != "google_1" {
			t.Fatalf("%s owner_id = %v, want the caller", eventType, got)
		}
	}
}

func TestMissedCarriesNoAnsweredAt(t *testing.T) {
	js := &recordingJS{}
	missed := sampleCall()
	missed.AnsweredAt = time.Time{}
	missed.DurationSeconds = 0
	missed.Reason = "missed"

	if err := newTestPublisher(js).Publish(TypeCallMissed, missed); err != nil {
		t.Fatalf("Publish: %v", err)
	}
	payload := decodeOnly(t, js.bodies[0])["payload"].(map[string]any)
	if _, present := payload["answered_at"]; present {
		t.Fatal("a missed call was never answered")
	}
}

func TestNilPublisherIsSilentlyFine(t *testing.T) {
	// With NATS unavailable a call must still connect; only history is lost.
	var publisher *Publisher
	if err := publisher.Publish(TypeCallStarted, sampleCall()); err != nil {
		t.Fatalf("a nil publisher must be a no-op, got %v", err)
	}
	if NewPublisher(nil) != nil {
		t.Fatal("NewPublisher(nil) must yield a nil publisher")
	}
}

func TestPublishSurfacesABrokerFailure(t *testing.T) {
	js := &recordingJS{err: errors.New("no stream")}
	if err := newTestPublisher(js).Publish(TypeCallEnded, sampleCall()); err == nil {
		t.Fatal("a publish failure must be reported to the caller, which logs it")
	}
}

func TestPayloadCarriesTheMediaKind(t *testing.T) {
	// messenger-service projects this into calls.media, which is what lets a
	// history row say "Video call" rather than guessing from a duration.
	for _, media := range []string{"audio", "video"} {
		js := &recordingJS{}
		call := sampleCall()
		call.Media = media
		if err := newTestPublisher(js).Publish(TypeCallEnded, call); err != nil {
			t.Fatalf("Publish: %v", err)
		}

		payload, ok := decodeOnly(t, js.bodies[0])["payload"].(map[string]any)
		if !ok {
			t.Fatal("envelope carried no payload object")
		}
		if payload["media"] != media {
			t.Fatalf("payload media = %v, want %q", payload["media"], media)
		}
	}
}

func groupCall() CallEvent {
	e := sampleCall()
	e.CalleeID = ""
	e.ParticipantIDs = []string{"google_1", "google_2", "google_3"}
	return e
}

func TestAGroupMissedEventNamesThePersonItIsAbout(t *testing.T) {
	// A group call has no callee, so before this the envelope carried an empty
	// owner_id and notification-service skipped it outright — not a bad row,
	// but nobody's bell rang. One event per person who did not answer.
	js := &recordingJS{}
	publisher := newTestPublisher(js)

	e := groupCall()
	e.JoinedIDs = []string{"google_1"}
	e.MissedOwnerID = "google_3"
	if err := publisher.Publish(TypeCallMissed, e); err != nil {
		t.Fatalf("Publish: %v", err)
	}

	body := decodeOnly(t, js.bodies[0])
	if body["owner_id"] != "google_3" {
		t.Fatalf("owner_id = %v, want the person who missed it", body["owner_id"])
	}
	payload, _ := body["payload"].(map[string]any)
	if payload["missed_owner_id"] != "google_3" {
		t.Fatalf("payload = %v, want missed_owner_id", payload)
	}
	// A group call must not claim a callee: the projection keys history on it,
	// and an arbitrary participant would become "the person who was called".
	if _, present := payload["callee_id"]; present {
		t.Fatalf("payload carries callee_id for a group call: %v", payload)
	}
}

func TestA1To1MissedStillAttributesToTheCallee(t *testing.T) {
	// The group path must not change who a 1:1 missed call is about.
	js := &recordingJS{}
	publisher := newTestPublisher(js)

	if err := publisher.Publish(TypeCallMissed, sampleCall()); err != nil {
		t.Fatalf("Publish: %v", err)
	}
	body := decodeOnly(t, js.bodies[0])
	if body["owner_id"] != "google_2" {
		t.Fatalf("owner_id = %v, want the callee", body["owner_id"])
	}
}

func TestCallEventCarriesWhoWasInvitedAndWhoJoined(t *testing.T) {
	js := &recordingJS{}
	publisher := newTestPublisher(js)

	e := groupCall()
	e.JoinedIDs = []string{"google_1", "google_2"}
	if err := publisher.Publish(TypeCallEnded, e); err != nil {
		t.Fatalf("Publish: %v", err)
	}

	payload, _ := decodeOnly(t, js.bodies[0])["payload"].(map[string]any)
	invited, _ := payload["participant_ids"].([]any)
	joined, _ := payload["joined_ids"].([]any)
	if len(invited) != 3 || len(joined) != 2 {
		t.Fatalf("payload = %v, want 3 invited and 2 joined", payload)
	}
}

func TestAnUnansweredGroupCallSendsAnEmptyJoinedSetRatherThanNone(t *testing.T) {
	// Absent and empty mean different things to a projection: one is "no
	// information", the other is the fact that nobody picked up.
	js := &recordingJS{}
	publisher := newTestPublisher(js)

	e := groupCall()
	e.JoinedIDs = nil
	e.MissedOwnerID = "google_2"
	if err := publisher.Publish(TypeCallMissed, e); err != nil {
		t.Fatalf("Publish: %v", err)
	}

	payload, _ := decodeOnly(t, js.bodies[0])["payload"].(map[string]any)
	joined, present := payload["joined_ids"]
	if !present {
		t.Fatalf("joined_ids is absent; want an empty list: %v", payload)
	}
	if items, _ := joined.([]any); len(items) != 0 {
		t.Fatalf("joined_ids = %v, want empty", joined)
	}
}
