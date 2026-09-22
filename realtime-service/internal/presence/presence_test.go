package presence

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

type memStore struct {
	values map[string]string
	ttls   map[string]time.Duration
	failed bool
}

func newMemStore() *memStore {
	return &memStore{values: map[string]string{}, ttls: map[string]time.Duration{}}
}

func (s *memStore) SetWithTTL(_ context.Context, key, value string, ttl time.Duration) error {
	if s.failed {
		return errors.New("redis down")
	}
	s.values[key] = value
	s.ttls[key] = ttl
	return nil
}

func (s *memStore) Delete(_ context.Context, keys ...string) error {
	for _, key := range keys {
		delete(s.values, key)
		delete(s.ttls, key)
	}
	return nil
}

func (s *memStore) KeysWithPrefix(_ context.Context, prefix string) ([]string, error) {
	var out []string
	for key := range s.values {
		if strings.HasPrefix(key, prefix) {
			out = append(out, key)
		}
	}
	return out, nil
}

func (s *memStore) GetAll(_ context.Context, keys []string) (map[string]string, error) {
	out := map[string]string{}
	for _, key := range keys {
		if v, ok := s.values[key]; ok {
			out[key] = v
		}
	}
	return out, nil
}

func TestBeatWritesPerConnectionKeyWithTTL(t *testing.T) {
	store := newMemStore()
	tracker := NewTracker(store, 45*time.Second)

	if err := tracker.Beat(context.Background(), "google_1", "conn-a", StateOnline); err != nil {
		t.Fatalf("Beat: %v", err)
	}
	key := Key("google_1", "conn-a")
	if store.values[key] != StateOnline {
		t.Fatalf("value = %q, want %q", store.values[key], StateOnline)
	}
	if store.ttls[key] != 45*time.Second {
		t.Fatalf("ttl = %v, want 45s", store.ttls[key])
	}
}

func TestBeatRefusesOfflineFromAClient(t *testing.T) {
	// A crashed tab cannot report anything, so `offline` is TTL expiry only.
	// Accepting a client-sent offline would let one tab log another one out.
	tracker := NewTracker(newMemStore(), time.Minute)
	if err := tracker.Beat(context.Background(), "google_1", "conn-a", StateOffline); err == nil {
		t.Fatal("offline must not be reportable by a client")
	}
}

func TestStateResolvesAcrossTabs(t *testing.T) {
	store := newMemStore()
	tracker := NewTracker(store, time.Minute)
	ctx := context.Background()

	if state, err := tracker.State(ctx, "google_1"); err != nil || state != StateOffline {
		t.Fatalf("state = %q, err = %v; want offline with no keys", state, err)
	}

	_ = tracker.Beat(ctx, "google_1", "conn-a", StateAway)
	if state, _ := tracker.State(ctx, "google_1"); state != StateAway {
		t.Fatalf("state = %q, want away", state)
	}

	// One online tab wins over any number of away ones.
	_ = tracker.Beat(ctx, "google_1", "conn-b", StateOnline)
	if state, _ := tracker.State(ctx, "google_1"); state != StateOnline {
		t.Fatalf("state = %q, want online", state)
	}
}

func TestClearOneTabLeavesTheOtherOnline(t *testing.T) {
	store := newMemStore()
	tracker := NewTracker(store, time.Minute)
	ctx := context.Background()
	_ = tracker.Beat(ctx, "google_1", "conn-a", StateOnline)
	_ = tracker.Beat(ctx, "google_1", "conn-b", StateOnline)

	if err := tracker.Clear(ctx, "google_1", "conn-a"); err != nil {
		t.Fatalf("Clear: %v", err)
	}
	if state, _ := tracker.State(ctx, "google_1"); state != StateOnline {
		t.Fatalf("state = %q after closing one tab, want online", state)
	}

	_ = tracker.Clear(ctx, "google_1", "conn-b")
	if state, _ := tracker.State(ctx, "google_1"); state != StateOffline {
		t.Fatalf("state = %q after last tab closed, want offline", state)
	}
}

func TestStatesBatchesOwners(t *testing.T) {
	store := newMemStore()
	tracker := NewTracker(store, time.Minute)
	ctx := context.Background()
	_ = tracker.Beat(ctx, "google_1", "conn-a", StateOnline)

	states, err := tracker.States(ctx, []string{"google_1", "google_2"})
	if err != nil {
		t.Fatalf("States: %v", err)
	}
	if states["google_1"] != StateOnline || states["google_2"] != StateOffline {
		t.Fatalf("states = %v", states)
	}
}

func TestBeatSurfacesStoreFailures(t *testing.T) {
	store := newMemStore()
	store.failed = true
	tracker := NewTracker(store, time.Minute)
	if err := tracker.Beat(context.Background(), "google_1", "conn-a", StateOnline); err == nil {
		t.Fatal("a failed write must be reported, not swallowed")
	}
}
