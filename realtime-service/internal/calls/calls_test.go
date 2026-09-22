package calls

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"datha-platform/realtime-service/internal/kv"
)

type memStore struct {
	mu     sync.Mutex
	values map[string]string
	ttls   map[string]time.Duration
	hashes map[string]map[string]string
	sets   map[string]map[string]struct{}
}

func newMemStore() *memStore {
	return &memStore{
		values: map[string]string{},
		ttls:   map[string]time.Duration{},
		hashes: map[string]map[string]string{},
	}
}

// HJoin mirrors the Redis script: free field, or the same session taking its
// own place back. Anything else loses.
func (s *memStore) HJoin(_ context.Context, key, field, value, sessionID string, ttl time.Duration) (bool, error) {
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
	s.ttls[key] = ttl
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

func (s *memStore) SetWithTTL(_ context.Context, key, value string, ttl time.Duration) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.values[key] = value
	s.ttls[key] = ttl
	return nil
}

func (s *memStore) ClaimWithTTL(_ context.Context, key, value string, ttl time.Duration) (bool, string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if held, ok := s.values[key]; ok {
		return false, held, nil
	}
	s.values[key] = value
	s.ttls[key] = ttl
	return true, value, nil
}

func (s *memStore) StealWithTTL(_ context.Context, key, value string, ttl time.Duration) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.values[key] = value
	s.ttls[key] = ttl
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

func (s *memStore) Delete(_ context.Context, keys ...string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, key := range keys {
		delete(s.values, key)
		delete(s.ttls, key)
		delete(s.hashes, key)
		delete(s.sets, key)
	}
	return nil
}

func newCall() *Call {
	return &Call{
		ID:             "call-1",
		ConversationID: "conv-1",
		CallerID:       "google_1",
		CalleeID:       "google_2",
		Participants:   []string{"google_1", "google_2"},
	}
}

func newGroupCall() *Call {
	return &Call{
		ID:             "call-1",
		ConversationID: "conv-1",
		CallerID:       "google_1",
		Participants:   []string{"google_1", "google_2", "google_3"},
	}
}

func TestCreateRecordsARingingCallWithTheRingingTTL(t *testing.T) {
	store := newMemStore()
	registry := NewRegistry(store, 45*time.Second, time.Hour, 4)

	call := newCall()
	if err := registry.Create(context.Background(), call, "conn-caller", ""); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if call.Status != StatusRinging || call.StartedAt.IsZero() {
		t.Fatalf("call = %+v, want ringing with a start time", call)
	}
	if got := store.ttls["call:call-1"]; got != 45*time.Second {
		t.Fatalf("ttl = %v, want the ringing ttl", got)
	}

	loaded, err := registry.Get(context.Background(), "call-1")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if loaded.CallerID != "google_1" || loaded.CalleeID != "google_2" {
		t.Fatalf("loaded = %+v", loaded)
	}
}

func TestGetReportsNotFoundForAnExpiredCall(t *testing.T) {
	registry := NewRegistry(newMemStore(), time.Minute, time.Hour, 4)
	// Expiry is a normal answer here: both peers may send a final frame, and
	// the second one arrives after the state is gone.
	if _, err := registry.Get(context.Background(), "gone"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}

func TestJoinIsFirstTabWinsAndReArmsTheActiveTTL(t *testing.T) {
	store := newMemStore()
	registry := NewRegistry(store, 45*time.Second, time.Hour, 4)
	call := newCall()
	if err := registry.Create(context.Background(), call, "conn-caller", ""); err != nil {
		t.Fatalf("Create: %v", err)
	}

	// An invite reaches every tab the callee has open, so two can answer within
	// milliseconds of each other. Exactly one must proceed.
	won, err := registry.Join(context.Background(), call, "google_2", "conn-a", "")
	if err != nil || !won {
		t.Fatalf("first join: won = %v, err = %v; want true, nil", won, err)
	}
	if err := registry.Activate(context.Background(), call); err != nil {
		t.Fatalf("Activate: %v", err)
	}
	if call.Status != StatusActive || call.AnsweredAt.IsZero() {
		t.Fatalf("call = %+v, want active with an answered time", call)
	}
	if got := store.ttls["call:call-1"]; got != time.Hour {
		t.Fatalf("ttl = %v, want the active ttl", got)
	}

	won, err = registry.Join(context.Background(), newCall(), "google_2", "conn-b", "")
	if err != nil {
		t.Fatalf("second join: %v", err)
	}
	if won {
		t.Fatal("two tabs of one person both won the join race")
	}
}

func TestActivateDoesNotRestampAnAlreadyActiveCall(t *testing.T) {
	// In a group the second and third people to join both call Activate. A
	// restamped answer time would reset the duration every time someone arrives.
	registry := NewRegistry(newMemStore(), 45*time.Second, time.Hour, 4)
	call := newGroupCall()
	if err := registry.Create(context.Background(), call, "conn-caller", ""); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := registry.Activate(context.Background(), call); err != nil {
		t.Fatalf("Activate: %v", err)
	}
	first := call.AnsweredAt

	if err := registry.Activate(context.Background(), call); err != nil {
		t.Fatalf("second Activate: %v", err)
	}
	if !call.AnsweredAt.Equal(first) {
		t.Fatalf("answered at = %v, want it unchanged at %v", call.AnsweredAt, first)
	}
}

func TestJoinIsPerOwnerSoSeveralPeopleCanArriveAtOnce(t *testing.T) {
	// The 1:1 lock was per *call*, which would let exactly one person into a
	// group. The field is the owner id, so each person wins their own.
	registry := NewRegistry(newMemStore(), 45*time.Second, time.Hour, 4)
	call := newGroupCall()
	if err := registry.Create(context.Background(), call, "conn-caller", ""); err != nil {
		t.Fatalf("Create: %v", err)
	}

	for _, ownerID := range []string{"google_2", "google_3"} {
		won, err := registry.Join(context.Background(), call, ownerID, "conn-"+ownerID, "")
		if err != nil || !won {
			t.Fatalf("%s join: won = %v, err = %v; want true, nil", ownerID, won, err)
		}
	}

	members, err := registry.Members(context.Background(), call.ID)
	if err != nil {
		t.Fatalf("Members: %v", err)
	}
	if len(members) != 3 {
		t.Fatalf("members = %d, want 3 (the caller and both joiners)", len(members))
	}
	// Sorted by owner id, which is what lets both ends of a pair compute the
	// same initiator without comparing notes.
	if members[0].OwnerID != "google_1" || members[2].OwnerID != "google_3" {
		t.Fatalf("members = %+v, want them ordered by owner id", members)
	}
}

func TestJoinIsRefusedOnceTheMeshIsFull(t *testing.T) {
	registry := NewRegistry(newMemStore(), 45*time.Second, time.Hour, 2)
	call := &Call{
		ID:           "call-1",
		CallerID:     "google_1",
		Participants: []string{"google_1", "google_2", "google_3"},
	}
	if err := registry.Create(context.Background(), call, "conn-caller", ""); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if _, err := registry.Join(context.Background(), call, "google_2", "conn-b", ""); err != nil {
		t.Fatalf("second join: %v", err)
	}

	// A mesh of three means every peer holds two connections and uplinks its own
	// video twice; the cap is a media limit, not a policy one.
	if _, err := registry.Join(context.Background(), call, "google_3", "conn-c", ""); !errors.Is(err, ErrFull) {
		t.Fatalf("err = %v, want ErrFull", err)
	}
}

func TestJoinRefusesSomeoneWhoWasNeverInvited(t *testing.T) {
	registry := NewRegistry(newMemStore(), 45*time.Second, time.Hour, 4)
	call := newGroupCall()
	if err := registry.Create(context.Background(), call, "conn-caller", ""); err != nil {
		t.Fatalf("Create: %v", err)
	}

	won, err := registry.Join(context.Background(), call, "google_9", "conn-x", "")
	if err != nil {
		t.Fatalf("Join: %v", err)
	}
	if won {
		t.Fatal("someone outside the invited set joined the call")
	}
}

func TestLeaveRemovesOnePersonAndIsIdempotent(t *testing.T) {
	registry := NewRegistry(newMemStore(), 45*time.Second, time.Hour, 4)
	call := newGroupCall()
	_ = registry.Create(context.Background(), call, "conn-caller", "")
	_, _ = registry.Join(context.Background(), call, "google_2", "conn-b", "")

	if err := registry.Leave(context.Background(), call.ID, "google_2"); err != nil {
		t.Fatalf("Leave: %v", err)
	}
	// A hang-up and a dropped socket can both report the same departure.
	if err := registry.Leave(context.Background(), call.ID, "google_2"); err != nil {
		t.Fatalf("second Leave: %v", err)
	}

	members, _ := registry.Members(context.Background(), call.ID)
	if len(members) != 1 || members[0].OwnerID != "google_1" {
		t.Fatalf("members = %+v, want the caller alone", members)
	}
}

func TestCreateJoinsTheCaller(t *testing.T) {
	// The caller is in the room they are ringing. Everything that reads the
	// member set — when a call is empty, who a newcomer negotiates with — then
	// reads it from one place.
	registry := NewRegistry(newMemStore(), 45*time.Second, time.Hour, 4)
	call := newCall()
	if err := registry.Create(context.Background(), call, "conn-caller", ""); err != nil {
		t.Fatalf("Create: %v", err)
	}

	members, err := registry.Members(context.Background(), call.ID)
	if err != nil {
		t.Fatalf("Members: %v", err)
	}
	if len(members) != 1 || members[0].OwnerID != "google_1" {
		t.Fatalf("members = %+v, want the caller", members)
	}
	if members[0].ConnID != "conn-caller" {
		t.Fatalf("conn = %q, want the inviting connection", members[0].ConnID)
	}
}

func TestJoinIsAtomicUnderConcurrentTabs(t *testing.T) {
	store := newMemStore()
	registry := NewRegistry(store, 45*time.Second, time.Hour, 4)
	if err := registry.Create(context.Background(), newCall(), "conn-caller", ""); err != nil {
		t.Fatalf("Create: %v", err)
	}

	const tabs = 8
	var (
		wg    sync.WaitGroup
		mu    sync.Mutex
		winds int
	)
	wg.Add(tabs)
	for i := 0; i < tabs; i++ {
		go func(i int) {
			defer wg.Done()
			won, err := registry.Join(context.Background(), newCall(), "google_2", "conn", "")
			if err != nil {
				t.Errorf("tab %d: %v", i, err)
				return
			}
			if won {
				mu.Lock()
				winds++
				mu.Unlock()
			}
		}(i)
	}
	wg.Wait()

	if winds != 1 {
		t.Fatalf("winners = %d, want exactly 1", winds)
	}
}

func TestEndClearsTheCallAndItsMembers(t *testing.T) {
	store := newMemStore()
	registry := NewRegistry(store, 45*time.Second, time.Hour, 4)
	call := newCall()
	_ = registry.Create(context.Background(), call, "conn-caller", "")
	_, _ = registry.Join(context.Background(), call, "google_2", "conn-a", "")

	if _, err := registry.End(context.Background(), call); err != nil {
		t.Fatalf("End: %v", err)
	}
	// The member hash must go with the call: leaving it behind would make a
	// later call that reuses the id unjoinable.
	if _, exists := store.values["call:call-1"]; exists {
		t.Fatal("call:call-1 survived End")
	}
	if len(store.hashes["call:call-1:members"]) != 0 {
		t.Fatal("call:call-1:members survived End")
	}
}

func TestInitiatorIsTheLowerOwnerIDFromBothSides(t *testing.T) {
	// Matrix MSC3401's full-mesh rule. Deliberately not "whoever was there
	// first": two people joining in the same instant each see the other as the
	// newcomer, so arrival order is not knowable to both sides.
	if got := Initiator("google_a", "google_b"); got != "google_a" {
		t.Fatalf("Initiator = %q, want the lower id", got)
	}
	if got := Initiator("google_b", "google_a"); got != "google_a" {
		t.Fatalf("Initiator is not symmetric: got %q", got)
	}
}

func TestAGroupCallHasNoSinglePeer(t *testing.T) {
	// A derived peer is what made 1:1 signaling safe. There is no such thing in
	// a mesh, so it must answer empty rather than picking an arbitrary member —
	// the handler turns that into "to is required".
	call := newGroupCall()
	if got := call.Peer("google_1"); got != "" {
		t.Fatalf("Peer in a group = %q, want empty", got)
	}
	if !call.IsGroup() {
		t.Fatal("a three-person call must be a group")
	}
}

func TestPeerAndParticipantRejectOutsiders(t *testing.T) {
	call := newCall()
	if got := call.Peer("google_1"); got != "google_2" {
		t.Fatalf("Peer(caller) = %q, want the callee", got)
	}
	if got := call.Peer("google_2"); got != "google_1" {
		t.Fatalf("Peer(callee) = %q, want the caller", got)
	}
	// An outsider gets no peer and no membership — this is what stops a
	// stranger relaying signaling into someone else's call.
	if got := call.Peer("google_9"); got != "" {
		t.Fatalf("Peer(outsider) = %q, want empty", got)
	}
	if call.HasParticipant("google_9") {
		t.Fatal("an outsider must not be a participant")
	}
}

func TestClientReasonsExcludeServerConclusions(t *testing.T) {
	// `missed` and `answered_elsewhere` are things the server decides. A client
	// asserting them would let a caller forge someone else's history row.
	for _, reason := range []string{ReasonMissed, ReasonAnsweredElsewhere} {
		if ClientReasons[reason] {
			t.Fatalf("%q must not be assertable by a client", reason)
		}
	}
	for _, reason := range []string{ReasonHangup, ReasonDeclined, ReasonBusy, ReasonICEFailed} {
		if !ClientReasons[reason] {
			t.Fatalf("%q must be assertable by a client", reason)
		}
	}
}

func TestAReloadedTabTakesItsOwnPlaceBack(t *testing.T) {
	// A reload arrives as a *new connection carrying the same session*, which
	// is the one case where "someone already holds this" means "you do".
	// Without the takeover a reload locks a person out of a call they are in
	// until the TTL expires.
	registry := NewRegistry(newMemStore(), 45*time.Second, time.Hour, 4)
	call := newCall()
	_ = registry.Create(context.Background(), call, "conn-caller", "session-caller")

	won, err := registry.Join(context.Background(), call, "google_2", "conn-a", "tab-1")
	if err != nil || !won {
		t.Fatalf("first join: won = %v, err = %v", won, err)
	}

	won, err = registry.Join(context.Background(), call, "google_2", "conn-b", "tab-1")
	if err != nil || !won {
		t.Fatalf("rejoin: won = %v, err = %v; want the same tab to take it back", won, err)
	}

	members, _ := registry.Members(context.Background(), call.ID)
	for _, member := range members {
		if member.OwnerID != "google_2" {
			continue
		}
		// The stored connection must be the new one: it is what makes the old
		// socket's own cleanup a no-op when it finally arrives.
		if member.ConnID != "conn-b" {
			t.Fatalf("conn = %q, want the reconnected one", member.ConnID)
		}
	}
}

func TestASecondTabWithItsOwnSessionStillLoses(t *testing.T) {
	// The takeover must not become "last writer wins": an invite rings every
	// tab, and a second one answering would steal a call already in progress.
	registry := NewRegistry(newMemStore(), 45*time.Second, time.Hour, 4)
	call := newCall()
	_ = registry.Create(context.Background(), call, "conn-caller", "session-caller")
	_, _ = registry.Join(context.Background(), call, "google_2", "conn-a", "tab-1")

	won, err := registry.Join(context.Background(), call, "google_2", "conn-b", "tab-2")
	if err != nil {
		t.Fatalf("second tab: %v", err)
	}
	if won {
		t.Fatal("a different tab took over a place it did not hold")
	}
}

func TestJoinWithoutASessionNeverTakesOver(t *testing.T) {
	// A client that supplies no session gets the plain first-wins behaviour, so
	// an absent session can never be matched against another absent one.
	registry := NewRegistry(newMemStore(), 45*time.Second, time.Hour, 4)
	call := newCall()
	_ = registry.Create(context.Background(), call, "conn-caller", "")
	_, _ = registry.Join(context.Background(), call, "google_2", "conn-a", "")

	won, err := registry.Join(context.Background(), call, "google_2", "conn-b", "")
	if err != nil {
		t.Fatalf("Join: %v", err)
	}
	if won {
		t.Fatal("an empty session matched another empty session")
	}
}

func TestLeaveIfHeldByIgnoresASupersededConnection(t *testing.T) {
	// The race this whole design exists for: a tab reloads, the new connection
	// takes the place over, and *then* the old socket's close is processed.
	// Removing unconditionally there drops a person out of a call they are
	// sitting in.
	registry := NewRegistry(newMemStore(), 45*time.Second, time.Hour, 4)
	call := newCall()
	_ = registry.Create(context.Background(), call, "conn-caller", "session-caller")
	_, _ = registry.Join(context.Background(), call, "google_2", "conn-a", "tab-1")
	_, _ = registry.Join(context.Background(), call, "google_2", "conn-b", "tab-1")

	removed, err := registry.LeaveIfHeldBy(context.Background(), call.ID, "google_2", "conn-a")
	if err != nil {
		t.Fatalf("LeaveIfHeldBy: %v", err)
	}
	if removed {
		t.Fatal("the old connection's close evicted the reconnected tab")
	}

	members, _ := registry.Members(context.Background(), call.ID)
	if len(members) != 2 {
		t.Fatalf("members = %+v, want both people still in the call", members)
	}

	// And the connection that does hold it still removes itself.
	removed, err = registry.LeaveIfHeldBy(context.Background(), call.ID, "google_2", "conn-b")
	if err != nil || !removed {
		t.Fatalf("holder leave: removed = %v, err = %v; want true, nil", removed, err)
	}
}

func TestEverJoinedKeepsSomeoneWhoLeftBeforeTheEnd(t *testing.T) {
	// The member hash answers "who is here now" and loses someone the moment
	// they leave, which is the wrong answer for the record of who was on the
	// call. Somebody who joins a four-way call and drops out early was on it.
	registry := NewRegistry(newMemStore(), 45*time.Second, time.Hour, 4)
	call := newGroupCall()
	_ = registry.Create(context.Background(), call, "conn-caller", "")
	_, _ = registry.Join(context.Background(), call, "google_2", "conn-b", "")
	_, _ = registry.Join(context.Background(), call, "google_3", "conn-c", "")
	_ = registry.Leave(context.Background(), call.ID, "google_3")

	members, _ := registry.Members(context.Background(), call.ID)
	if len(members) != 2 {
		t.Fatalf("members = %+v, want the two still in the call", members)
	}

	joined, err := registry.EverJoined(context.Background(), call.ID)
	if err != nil {
		t.Fatalf("EverJoined: %v", err)
	}
	if len(joined) != 3 {
		t.Fatalf("joined = %v, want all three, including the one who left", joined)
	}
}

func TestNeverJoinedListsTheInvitedWhoDidNotAnswer(t *testing.T) {
	registry := NewRegistry(newMemStore(), 45*time.Second, time.Hour, 4)
	call := newGroupCall()
	_ = registry.Create(context.Background(), call, "conn-caller", "")
	_, _ = registry.Join(context.Background(), call, "google_2", "conn-b", "")

	missed, err := registry.NeverJoined(context.Background(), call)
	if err != nil {
		t.Fatalf("NeverJoined: %v", err)
	}
	// The caller joined at creation, so only the silent invitee is missed.
	if len(missed) != 1 || missed[0] != "google_3" {
		t.Fatalf("missed = %v, want only google_3", missed)
	}
}

func TestEndClearsTheJoinedSetWithTheCall(t *testing.T) {
	registry := NewRegistry(newMemStore(), 45*time.Second, time.Hour, 4)
	call := newGroupCall()
	_ = registry.Create(context.Background(), call, "conn-caller", "")
	_, _ = registry.Join(context.Background(), call, "google_2", "conn-b", "")

	if _, err := registry.End(context.Background(), call); err != nil {
		t.Fatalf("End: %v", err)
	}
	joined, _ := registry.EverJoined(context.Background(), call.ID)
	if len(joined) != 0 {
		t.Fatalf("joined = %v, want it cleared with the call", joined)
	}
}

// A conversation holds at most one live call.
//
// Without this a third person pressing Call during a call created a second one:
// everybody already talking was rung again, and the browser's glare rule — which
// exists so two people dialling each other in a 1:1 do not both win — made the
// polite side hang up the call it was in to take the new ring. One press could
// empty a room (dathq, 2026-09-15). Every mainstream client resolves this the
// same way: you join the call that is happening, you do not start a rival.
func TestCreateRefusesASecondCallInTheSameConversation(t *testing.T) {
	ctx := context.Background()
	store := newMemStore()
	registry := NewRegistry(store, 45*time.Second, time.Hour, 4)

	first := newGroupCall()
	if err := registry.Create(ctx, first, "conn-caller", ""); err != nil {
		t.Fatalf("first Create: %v", err)
	}

	second := newGroupCall()
	second.ID = "call-2"
	second.CallerID = "google_3"
	err := registry.Create(ctx, second, "conn-other", "")

	var busy ErrConversationBusy
	if !errors.As(err, &busy) {
		t.Fatalf("second Create: want ErrConversationBusy, got %v", err)
	}
	// The id is the whole point: "busy" alone leaves the client with nothing to
	// do, while the call's id turns the refusal into a join.
	if busy.CallID != first.ID {
		t.Fatalf("busy names %q, want %q", busy.CallID, first.ID)
	}
	if _, err := registry.Get(ctx, second.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("the refused call was written anyway: %v", err)
	}
}

// A claim that outlived its call must not make the conversation uncallable.
//
// The slot is held for the call's own lifetime, so an instance that died between
// ending a call and releasing the key would lock the conversation for the rest
// of the TTL — a worse failure than the one the claim prevents.
func TestCreateTakesOverAClaimWhoseCallIsGone(t *testing.T) {
	ctx := context.Background()
	store := newMemStore()
	registry := NewRegistry(store, 45*time.Second, time.Hour, 4)

	// A slot pointing at a call that is not there.
	if err := store.StealWithTTL(ctx, conversationKey("conv-1"), "call-vanished", time.Hour); err != nil {
		t.Fatalf("seed claim: %v", err)
	}

	call := newGroupCall()
	if err := registry.Create(ctx, call, "conn-caller", ""); err != nil {
		t.Fatalf("Create over a stale claim: %v", err)
	}
	if got := store.values[conversationKey("conv-1")]; got != call.ID {
		t.Fatalf("claim holds %q, want %q", got, call.ID)
	}
}

func TestEndReleasesTheConversation(t *testing.T) {
	ctx := context.Background()
	store := newMemStore()
	registry := NewRegistry(store, 45*time.Second, time.Hour, 4)

	call := newGroupCall()
	if err := registry.Create(ctx, call, "conn-caller", ""); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if _, err := registry.End(ctx, call); err != nil {
		t.Fatalf("End: %v", err)
	}
	if _, exists := store.values[conversationKey("conv-1")]; exists {
		t.Fatal("the conversation claim survived the call")
	}

	// And the conversation is callable again straight away.
	next := newGroupCall()
	next.ID = "call-2"
	if err := registry.Create(ctx, next, "conn-caller", ""); err != nil {
		t.Fatalf("Create after End: %v", err)
	}
}

// The claim is armed for a *ringing* call, which is short. An answered call runs
// far longer, and a claim expiring under a live call would let a second one be
// created in a conversation that is plainly busy.
func TestActivateExtendsTheConversationClaim(t *testing.T) {
	ctx := context.Background()
	store := newMemStore()
	registry := NewRegistry(store, 45*time.Second, time.Hour, 4)

	call := newGroupCall()
	if err := registry.Create(ctx, call, "conn-caller", ""); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if got := store.ttls[conversationKey("conv-1")]; got != 45*time.Second {
		t.Fatalf("ringing claim ttl %v, want 45s", got)
	}

	if err := registry.Activate(ctx, call); err != nil {
		t.Fatalf("Activate: %v", err)
	}
	if got := store.ttls[conversationKey("conv-1")]; got != time.Hour {
		t.Fatalf("active claim ttl %v, want 1h", got)
	}
}

func (s *memStore) Consume(_ context.Context, key string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, existed := s.values[key]
	delete(s.values, key)
	delete(s.ttls, key)
	return existed, nil
}

func (s *memStore) KeysWithPrefix(_ context.Context, prefix string) ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	keys := make([]string, 0)
	for key := range s.values {
		if strings.HasPrefix(key, prefix) {
			keys = append(keys, key)
		}
	}
	for key := range s.hashes {
		if strings.HasPrefix(key, prefix) {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	return keys, nil
}
