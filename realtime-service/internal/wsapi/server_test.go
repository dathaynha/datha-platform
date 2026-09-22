package wsapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"datha-platform/realtime-service/internal/calls"
	"datha-platform/realtime-service/internal/chatauth"
	"datha-platform/realtime-service/internal/hub"
	"datha-platform/realtime-service/internal/kv"
	"datha-platform/realtime-service/internal/metrics"
	"datha-platform/realtime-service/internal/presence"
)

// --- test doubles -----------------------------------------------------------

type testSub struct {
	subject string
	bus     *testBus
}

func (s *testSub) Unsubscribe() error {
	s.bus.mu.Lock()
	delete(s.bus.handlers, s.subject)
	s.bus.mu.Unlock()
	return nil
}

// testBus is a loopback core bus: a publish is delivered to local subscribers,
// which is exactly what NATS does for two sockets on one instance.
type testBus struct {
	mu        sync.Mutex
	handlers  map[string]func([]byte)
	published []string
}

func newTestBus() *testBus {
	return &testBus{handlers: map[string]func([]byte){}}
}

func (b *testBus) Subscribe(subject string, handler func([]byte)) (hub.Subscription, error) {
	b.mu.Lock()
	b.handlers[subject] = handler
	b.mu.Unlock()
	return &testSub{subject: subject, bus: b}, nil
}

func (b *testBus) Publish(subject string, data []byte) error {
	b.mu.Lock()
	handler := b.handlers[subject]
	b.published = append(b.published, subject)
	b.mu.Unlock()
	if handler != nil {
		handler(data)
	}
	return nil
}

type memStore struct {
	mu     sync.Mutex
	values map[string]string
	hashes map[string]map[string]string
	sets   map[string]map[string]struct{}
}

func newMemStore() *memStore {
	return &memStore{
		values: map[string]string{},
		hashes: map[string]map[string]string{},
	}
}

// maxCallParticipants is the mesh ceiling the socket tests run against. Four is
// the production default; a test that needs a full call sets its own.
const maxCallParticipants = 4

func (s *memStore) SetWithTTL(_ context.Context, key, value string, _ time.Duration) error {
	s.mu.Lock()
	s.values[key] = value
	s.mu.Unlock()
	return nil
}

func (s *memStore) ClaimWithTTL(_ context.Context, key, value string, _ time.Duration) (bool, string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if held, ok := s.values[key]; ok {
		return false, held, nil
	}
	s.values[key] = value
	return true, value, nil
}

func (s *memStore) StealWithTTL(_ context.Context, key, value string, _ time.Duration) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.values[key] = value
	return nil
}

func (s *memStore) Delete(_ context.Context, keys ...string) error {
	s.mu.Lock()
	for _, key := range keys {
		delete(s.values, key)
		delete(s.hashes, key)
		delete(s.sets, key)
	}
	s.mu.Unlock()
	return nil
}

// Get and the hash/set methods exist so this one fake satisfies calls.Store as
// well as presence.Store — both are TTL'd data over the same client.
//
// HJoin mirrors the Redis script: free field, or the same session taking its
// own place back. Anything else loses.
func (s *memStore) HJoin(_ context.Context, key, field, value, sessionID string, _ time.Duration) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.hashes == nil {
		s.hashes = map[string]map[string]string{}
	}
	fields, ok := s.hashes[key]
	if !ok {
		fields = map[string]string{}
		s.hashes[key] = fields
	}

	existing, held := fields[field]
	if held {
		if sessionID == "" {
			return false, nil
		}
		var member struct {
			SessionID string `json:"session_id"`
		}
		if err := json.Unmarshal([]byte(existing), &member); err != nil || member.SessionID != sessionID {
			return false, nil
		}
	}
	fields[field] = value
	return true, nil
}

// HDelIfHeldBy mirrors the Redis script: remove only while connID holds it.
func (s *memStore) HDelIfHeldBy(_ context.Context, key, field, connID string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	existing, held := s.hashes[key][field]
	if !held {
		return false, nil
	}
	var member struct {
		ConnID string `json:"conn_id"`
	}
	if err := json.Unmarshal([]byte(existing), &member); err != nil || member.ConnID != connID {
		return false, nil
	}
	delete(s.hashes[key], field)
	return true, nil
}

func (s *memStore) SAddWithTTL(_ context.Context, key, member string, _ time.Duration) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.sets == nil {
		s.sets = map[string]map[string]struct{}{}
	}
	if s.sets[key] == nil {
		s.sets[key] = map[string]struct{}{}
	}
	s.sets[key][member] = struct{}{}
	return nil
}

func (s *memStore) SRem(_ context.Context, key, member string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.sets[key] != nil {
		delete(s.sets[key], member)
	}
	return nil
}

func (s *memStore) SMembers(_ context.Context, key string) ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]string, 0, len(s.sets[key]))
	for member := range s.sets[key] {
		out = append(out, member)
	}
	return out, nil
}

func (s *memStore) HGetAll(_ context.Context, key string) (map[string]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := map[string]string{}
	for field, value := range s.hashes[key] {
		out[field] = value
	}
	return out, nil
}

func (s *memStore) HDel(_ context.Context, key, field string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.hashes[key], field)
	return nil
}

func (s *memStore) Get(_ context.Context, key string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	value, ok := s.values[key]
	if !ok {
		return "", kv.ErrNotFound
	}
	return value, nil
}

func (s *memStore) KeysWithPrefix(_ context.Context, prefix string) ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []string
	for key := range s.values {
		if strings.HasPrefix(key, prefix) {
			out = append(out, key)
		}
	}
	return out, nil
}

func (s *memStore) GetAll(_ context.Context, keys []string) (map[string]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := map[string]string{}
	for _, key := range keys {
		if v, ok := s.values[key]; ok {
			out[key] = v
		}
	}
	return out, nil
}

type stubChecker struct {
	allow        bool
	participants []string
	err          error
}

func (c stubChecker) Lookup(_ context.Context, _, conversationID string) (*chatauth.Conversation, error) {
	if c.err != nil {
		return nil, c.err
	}
	if !c.allow {
		return nil, nil
	}
	return &chatauth.Conversation{ID: conversationID, Participants: c.participants}, nil
}

// --- harness ----------------------------------------------------------------

type harness struct {
	server *httptest.Server
	bus    *testBus
	store  *memStore
	hub    *hub.Hub
}

// newHarness starts a socket server over loopback doubles. `tune` lets a test
// shorten one interval without every other timer firing mid-test.
func newHarness(t *testing.T, checker chatauth.Checker, maxPerOwner int, tune ...func(*Timings)) *harness {
	t.Helper()
	return newHarnessWithCap(t, checker, maxPerOwner, maxCallParticipants, tune...)
}

// newHarnessWithCap is newHarness with the mesh ceiling lowered, so a test can
// fill a call without dialling four sockets.
func newHarnessWithCap(t *testing.T, checker chatauth.Checker, maxPerOwner, maxParticipants int, tune ...func(*Timings)) *harness {
	t.Helper()
	bus := newTestBus()
	store := newMemStore()
	h := hub.New(bus, maxPerOwner)
	registry := calls.NewRegistry(store, time.Minute, time.Hour, maxParticipants)
	timings := Timings{
		// Long enough that no timer fires mid-test; the tickers themselves are
		// exercised by the presence and hub unit tests.
		Ping:              time.Hour,
		PresenceHeartbeat: time.Hour,
		Typing:            8 * time.Second,
		CallRing:          time.Hour,
	}
	for _, apply := range tune {
		apply(&timings)
	}
	// nil publisher: call history is a JetStream concern covered by the events
	// package's own tests, and a live call must not depend on it.
	socket := NewServer(h, presence.NewTracker(store, time.Minute), checker, registry, nil, metrics.New(), timings)
	server := httptest.NewServer(http.HandlerFunc(socket.Handle))
	t.Cleanup(server.Close)
	return &harness{server: server, bus: bus, store: store, hub: h}
}

func (h *harness) dial(t *testing.T, ownerID string) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	url := "ws" + strings.TrimPrefix(h.server.URL, "http") + "/ws"
	conn, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{
		HTTPHeader: http.Header{"X-Owner-ID": []string{ownerID}},
	})
	if err != nil {
		t.Fatalf("dial as %s: %v", ownerID, err)
	}
	t.Cleanup(func() { _ = conn.Close(websocket.StatusNormalClosure, "") })
	return conn
}

func readFrame(t *testing.T, conn *websocket.Conn) Frame {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	_, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	frame, err := Decode(data)
	if err != nil {
		t.Fatalf("decode %s: %v", data, err)
	}
	return frame
}

// waitFor reads until a frame of the wanted type arrives, so an unrelated
// presence frame in flight cannot make an assertion flaky.
func waitFor(t *testing.T, conn *websocket.Conn, frameType string) Frame {
	t.Helper()
	for i := 0; i < 10; i++ {
		frame := readFrame(t, conn)
		if frame.T == frameType {
			return frame
		}
	}
	t.Fatalf("no %q frame arrived", frameType)
	return Frame{}
}

func send(t *testing.T, conn *websocket.Conn, frameType string, payload any) {
	t.Helper()
	data, err := Encode(frameType, payload)
	if err != nil {
		t.Fatalf("encode %s: %v", frameType, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := conn.Write(ctx, websocket.MessageText, data); err != nil {
		t.Fatalf("write %s: %v", frameType, err)
	}
}

// --- tests ------------------------------------------------------------------

func TestConnectRequiresOwnerHeader(t *testing.T) {
	h := newHarness(t, stubChecker{allow: true}, 5)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	url := "ws" + strings.TrimPrefix(h.server.URL, "http") + "/ws"
	if _, _, err := websocket.Dial(ctx, url, nil); err == nil {
		t.Fatal("a socket with no X-Owner-ID must be refused")
	}
}

func TestReadyFrameOnConnect(t *testing.T) {
	h := newHarness(t, stubChecker{allow: true}, 5)
	conn := h.dial(t, "google_1")

	frame := waitFor(t, conn, TypeReady)
	var payload ReadyPayload
	if err := DecodePayload(frame, &payload); err != nil {
		t.Fatalf("DecodePayload: %v", err)
	}
	if payload.OwnerID != "google_1" {
		t.Fatalf("owner_id = %q", payload.OwnerID)
	}
	if payload.ServerTime == "" {
		t.Fatal("ready frame carries no server_time")
	}
	if len(payload.Presence) == 0 || payload.Presence[0].State != presence.StateOnline {
		t.Fatalf("presence = %+v, want the caller online", payload.Presence)
	}
}

func TestOwnerFanoutReachesTheSocket(t *testing.T) {
	h := newHarness(t, stubChecker{allow: true}, 5)
	conn := h.dial(t, "google_1")
	waitFor(t, conn, TypeReady)

	// This is what messenger-service publishes after a durable write.
	if err := h.bus.Publish(hub.OwnerSubject("google_1"), []byte(`{"t":"message.new","d":{"conversation_id":"conv-1"}}`)); err != nil {
		t.Fatalf("publish: %v", err)
	}

	frame := waitFor(t, conn, "message.new")
	var payload struct {
		ConversationID string `json:"conversation_id"`
	}
	if err := json.Unmarshal(frame.D, &payload); err != nil {
		t.Fatalf("payload: %v", err)
	}
	if payload.ConversationID != "conv-1" {
		t.Fatalf("conversation_id = %q", payload.ConversationID)
	}
}

func TestOwnerFanoutIsNotDeliveredToOtherOwners(t *testing.T) {
	h := newHarness(t, stubChecker{allow: true}, 5)
	alice := h.dial(t, "google_alice")
	bob := h.dial(t, "google_bob")
	waitFor(t, alice, TypeReady)
	waitFor(t, bob, TypeReady)

	_ = h.bus.Publish(hub.OwnerSubject("google_alice"), []byte(`{"t":"unread.added","d":{}}`))

	// Alice gets it; Bob's socket must stay silent, so a short read deadline
	// expiring is the assertion.
	waitFor(t, alice, "unread.added")
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	if _, data, err := bob.Read(ctx); err == nil {
		t.Fatalf("bob received %s, want nothing", data)
	}
}

func TestPingIsAnswered(t *testing.T) {
	h := newHarness(t, stubChecker{allow: true}, 5)
	conn := h.dial(t, "google_1")
	waitFor(t, conn, TypeReady)

	send(t, conn, TypePing, map[string]any{})
	waitFor(t, conn, TypePong)
}

func TestUnknownFrameTypeGetsAnErrorNotADisconnect(t *testing.T) {
	h := newHarness(t, stubChecker{allow: true}, 5)
	conn := h.dial(t, "google_1")
	waitFor(t, conn, TypeReady)

	// Deliberately not a real frame type. It used to be "call.invite", which
	// phase 2 implemented — so the placeholder has to be something the
	// protocol will never carry.
	send(t, conn, "not.a.real.type", map[string]any{})
	frame := waitFor(t, conn, TypeError)
	var payload ErrorPayload
	_ = DecodePayload(frame, &payload)
	if payload.Code != "unknown_type" {
		t.Fatalf("code = %q, want unknown_type", payload.Code)
	}

	// The connection must still work — a socket may be carrying a call.
	send(t, conn, TypePing, map[string]any{})
	waitFor(t, conn, TypePong)
}

func TestMalformedFrameGetsAnErrorNotADisconnect(t *testing.T) {
	h := newHarness(t, stubChecker{allow: true}, 5)
	conn := h.dial(t, "google_1")
	waitFor(t, conn, TypeReady)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := conn.Write(ctx, websocket.MessageText, []byte("not json")); err != nil {
		t.Fatalf("write: %v", err)
	}

	frame := waitFor(t, conn, TypeError)
	var payload ErrorPayload
	_ = DecodePayload(frame, &payload)
	if payload.Code != "bad_frame" {
		t.Fatalf("code = %q, want bad_frame", payload.Code)
	}
	send(t, conn, TypePing, map[string]any{})
	waitFor(t, conn, TypePong)
}

func TestConversationOpenIsRefusedForNonParticipants(t *testing.T) {
	h := newHarness(t, stubChecker{allow: false}, 5)
	conn := h.dial(t, "google_carol")
	waitFor(t, conn, TypeReady)

	send(t, conn, TypeConversationOpen, ConversationPayload{ConversationID: "conv-1"})
	frame := waitFor(t, conn, TypeError)
	var payload ErrorPayload
	_ = DecodePayload(frame, &payload)
	if payload.Code != "forbidden" {
		t.Fatalf("code = %q, want forbidden", payload.Code)
	}
	if h.hub.Subscribed("", hub.ConversationSubject("conv-1")) {
		t.Fatal("a refused open must not leave a subscription behind")
	}
}

func TestTypingRelaysBetweenParticipantsWithServerStampedIdentity(t *testing.T) {
	h := newHarness(t, stubChecker{allow: true}, 5)
	alice := h.dial(t, "google_alice")
	bob := h.dial(t, "google_bob")
	waitFor(t, alice, TypeReady)
	waitFor(t, bob, TypeReady)

	send(t, alice, TypeConversationOpen, ConversationPayload{ConversationID: "conv-1"})
	send(t, bob, TypeConversationOpen, ConversationPayload{ConversationID: "conv-1"})
	// Give both opens time to land before the typing frame is published.
	time.Sleep(100 * time.Millisecond)

	send(t, alice, TypeTypingStart, ConversationPayload{ConversationID: "conv-1"})

	frame := waitFor(t, bob, TypeTyping)
	var payload TypingPayload
	if err := DecodePayload(frame, &payload); err != nil {
		t.Fatalf("DecodePayload: %v", err)
	}
	if payload.OwnerID != "google_alice" {
		t.Fatalf("owner_id = %q, want google_alice stamped by the server", payload.OwnerID)
	}
	if payload.ConversationID != "conv-1" {
		t.Fatalf("conversation_id = %q", payload.ConversationID)
	}
	if payload.Until == "" {
		t.Fatal("typing frame carries no expiry")
	}
}

func TestTypingIsRefusedWithoutAnOpenConversation(t *testing.T) {
	// The membership check happens once, at conversation.open; this is what
	// stops a client publishing into a conversation it never opened.
	h := newHarness(t, stubChecker{allow: true}, 5)
	conn := h.dial(t, "google_carol")
	waitFor(t, conn, TypeReady)

	send(t, conn, TypeTypingStart, ConversationPayload{ConversationID: "conv-1"})
	frame := waitFor(t, conn, TypeError)
	var payload ErrorPayload
	_ = DecodePayload(frame, &payload)
	if payload.Code != "forbidden" {
		t.Fatalf("code = %q, want forbidden", payload.Code)
	}
	for _, subject := range h.bus.published {
		if subject == hub.ConversationSubject("conv-1") {
			t.Fatal("a refused typing frame must never reach the bus")
		}
	}
}

func TestConversationCloseStopsTypingDelivery(t *testing.T) {
	h := newHarness(t, stubChecker{allow: true}, 5)
	alice := h.dial(t, "google_alice")
	bob := h.dial(t, "google_bob")
	waitFor(t, alice, TypeReady)
	waitFor(t, bob, TypeReady)

	send(t, alice, TypeConversationOpen, ConversationPayload{ConversationID: "conv-1"})
	send(t, bob, TypeConversationOpen, ConversationPayload{ConversationID: "conv-1"})
	time.Sleep(100 * time.Millisecond)
	send(t, bob, TypeConversationClose, ConversationPayload{ConversationID: "conv-1"})
	time.Sleep(100 * time.Millisecond)

	send(t, alice, TypeTypingStart, ConversationPayload{ConversationID: "conv-1"})

	ctx, cancel := context.WithTimeout(context.Background(), 400*time.Millisecond)
	defer cancel()
	if _, data, err := bob.Read(ctx); err == nil {
		t.Fatalf("bob received %s after closing the conversation", data)
	}
}

func TestPresenceSubscribeAnswersWithCurrentState(t *testing.T) {
	h := newHarness(t, stubChecker{allow: true}, 5)
	alice := h.dial(t, "google_alice")
	waitFor(t, alice, TypeReady)
	bob := h.dial(t, "google_bob")
	waitFor(t, bob, TypeReady)

	send(t, alice, TypePresenceSubscribe, PresenceSubscribePayload{OwnerIDs: []string{"google_bob"}})

	// A subscription only carries transitions, so the immediate answer is what
	// makes the dots render at all.
	for i := 0; i < 10; i++ {
		frame := waitFor(t, alice, TypePresence)
		var payload PresenceEntry
		_ = DecodePayload(frame, &payload)
		if payload.OwnerID == "google_bob" {
			if payload.State != presence.StateOnline {
				t.Fatalf("bob state = %q, want online", payload.State)
			}
			return
		}
	}
	t.Fatal("no presence frame for google_bob arrived")
}

func TestPresenceTransitionReachesSubscribers(t *testing.T) {
	h := newHarness(t, stubChecker{allow: true}, 5)
	alice := h.dial(t, "google_alice")
	waitFor(t, alice, TypeReady)
	bob := h.dial(t, "google_bob")
	waitFor(t, bob, TypeReady)

	send(t, alice, TypePresenceSubscribe, PresenceSubscribePayload{OwnerIDs: []string{"google_bob"}})
	time.Sleep(100 * time.Millisecond)

	send(t, bob, TypeAway, map[string]any{})

	for i := 0; i < 10; i++ {
		frame := waitFor(t, alice, TypePresence)
		var payload PresenceEntry
		_ = DecodePayload(frame, &payload)
		if payload.OwnerID == "google_bob" && payload.State == presence.StateAway {
			return
		}
	}
	t.Fatal("bob's away transition never reached alice")
}

func TestPerOwnerConnectionCapIsEnforced(t *testing.T) {
	h := newHarness(t, stubChecker{allow: true}, 1)
	first := h.dial(t, "google_1")
	waitFor(t, first, TypeReady)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	url := "ws" + strings.TrimPrefix(h.server.URL, "http") + "/ws"
	conn, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{
		HTTPHeader: http.Header{"X-Owner-ID": []string{"google_1"}},
	})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer func() { _ = conn.Close(websocket.StatusNormalClosure, "") }()

	// The upgrade succeeds and the server closes it with a policy violation.
	readCtx, readCancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer readCancel()
	_, _, err = conn.Read(readCtx)
	var closeErr websocket.CloseError
	if !errors.As(err, &closeErr) || closeErr.Code != websocket.StatusPolicyViolation {
		t.Fatalf("error = %v, want a policy-violation close", err)
	}
}

func TestDisconnectClearsPresence(t *testing.T) {
	h := newHarness(t, stubChecker{allow: true}, 5)
	conn := h.dial(t, "google_1")
	waitFor(t, conn, TypeReady)

	h.store.mu.Lock()
	live := len(h.store.values)
	h.store.mu.Unlock()
	if live != 1 {
		t.Fatalf("presence keys = %d while connected, want 1", live)
	}

	_ = conn.Close(websocket.StatusNormalClosure, "")

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		h.store.mu.Lock()
		remaining := len(h.store.values)
		h.store.mu.Unlock()
		if remaining == 0 && h.hub.Connections() == 0 {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("presence key or hub entry survived the disconnect")
}

func TestAFrameFloodIsRefusedOnceAndTheSocketSurvives(t *testing.T) {
	h := newHarness(t, stubChecker{allow: true}, 5)
	conn := h.dial(t, "google_1")
	waitFor(t, conn, TypeReady)

	// presence.away is silent on success, so anything that comes back is the
	// limiter talking. Well past the general burst, faster than it refills.
	for i := 0; i < framesBurst+80; i++ {
		send(t, conn, TypeAway, map[string]any{})
	}

	payload := ErrorPayload{}
	if err := DecodePayload(waitFor(t, conn, TypeError), &payload); err != nil {
		t.Fatalf("decode error frame: %v", err)
	}
	if payload.Code != "rate_limited" {
		t.Fatalf("code = %q, want rate_limited", payload.Code)
	}

	// The socket stays open — it may be carrying a call — and starts working
	// again once tokens accrue. A few tokens at framesRefill per second:
	time.Sleep(150 * time.Millisecond)
	send(t, conn, TypePing, map[string]any{})

	// The very next frame must be the pong: one notice went out, not one per
	// dropped frame, or an inbound flood would become an outbound one.
	frame := readFrame(t, conn)
	if frame.T != TypePong {
		t.Fatalf("next frame was %q, want a single notice then pong", frame.T)
	}
}

// drain reports whether a frame of the given type arrives shortly.
//
// It exists for the assertions that matter most here — that a candidate
// addressed to one participant reaches *nobody else*, and that one person
// leaving does not end the call for the rest. Those are absences, and an
// absence needs a bounded wait rather than a read that blocks forever.
func drain(t *testing.T, conn *websocket.Conn, frameType string) bool {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()

	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			return false
		}
		frame, err := Decode(data)
		if err != nil {
			continue
		}
		if frame.T == frameType {
			return true
		}
	}
}

func (s *memStore) Consume(_ context.Context, key string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, existed := s.values[key]
	delete(s.values, key)
	return existed, nil
}
