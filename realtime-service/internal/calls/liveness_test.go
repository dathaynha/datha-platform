package calls

import (
	"context"
	"testing"
	"time"
)

func seedCall(t *testing.T, r *Registry, store *memStore, instanceID string) *Call {
	t.Helper()
	r.instanceID = instanceID
	call := newGroupCall()
	if err := r.Create(context.Background(), call, "conn-1", ""); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := store.StealWithTTL(context.Background(), InstanceKey(instanceID), "1", time.Minute); err != nil {
		t.Fatalf("heartbeat: %v", err)
	}
	return call
}

// A call held by a live instance is nobody's business but that instance's.
func TestFindOrphansLeavesCallsWithALiveInstanceAlone(t *testing.T) {
	store := newMemStore()
	registry := NewRegistry(store, 45*time.Second, time.Hour, 4)
	seedCall(t, registry, store, "instance-a")

	orphans, err := registry.FindOrphans(context.Background())
	if err != nil {
		t.Fatalf("FindOrphans: %v", err)
	}
	if len(orphans) != 0 {
		t.Fatalf("reaped a live call: %+v", orphans)
	}
}

// The case the whole mechanism exists for: the process that was holding the
// call is gone, so nothing will ever close it through the ordinary path.
func TestFindOrphansFindsACallWhoseInstanceIsGone(t *testing.T) {
	ctx := context.Background()
	store := newMemStore()
	registry := NewRegistry(store, 45*time.Second, time.Hour, 4)
	call := seedCall(t, registry, store, "instance-a")

	// The instance dies: its heartbeat expires, while the call record and its
	// member hash sit there with hours of TTL left.
	if err := store.Delete(ctx, InstanceKey("instance-a")); err != nil {
		t.Fatalf("expire heartbeat: %v", err)
	}

	orphans, err := registry.FindOrphans(ctx)
	if err != nil {
		t.Fatalf("FindOrphans: %v", err)
	}
	if len(orphans) != 1 {
		t.Fatalf("want 1 orphan, got %d", len(orphans))
	}
	if orphans[0].Call.ID != call.ID {
		t.Fatalf("orphan is %q, want %q", orphans[0].Call.ID, call.ID)
	}
	if len(orphans[0].Stranded) != 1 || orphans[0].Stranded[0] != call.CallerID {
		t.Fatalf("stranded %v, want [%s]", orphans[0].Stranded, call.CallerID)
	}
}

// One survivor is enough to leave a call alone: their own socket closing will
// end it through the ordinary path, with the right reason and the right event.
func TestFindOrphansLeavesACallWithOneSurvivor(t *testing.T) {
	ctx := context.Background()
	store := newMemStore()
	registry := NewRegistry(store, 45*time.Second, time.Hour, 4)
	call := seedCall(t, registry, store, "instance-a")

	registry.instanceID = "instance-b"
	if _, err := registry.Join(ctx, call, "google_2", "conn-2", ""); err != nil {
		t.Fatalf("Join: %v", err)
	}
	if err := store.StealWithTTL(ctx, InstanceKey("instance-b"), "1", time.Minute); err != nil {
		t.Fatalf("heartbeat b: %v", err)
	}
	if err := store.Delete(ctx, InstanceKey("instance-a")); err != nil {
		t.Fatalf("expire heartbeat a: %v", err)
	}

	orphans, err := registry.FindOrphans(ctx)
	if err != nil {
		t.Fatalf("FindOrphans: %v", err)
	}
	if len(orphans) != 0 {
		t.Fatalf("reaped a call somebody is still in: %+v", orphans)
	}
}

// A member written before instance ids existed cannot be judged, and refusing to
// reap is the safe direction: a rolling deploy must not end live calls.
func TestFindOrphansTreatsAnUnstampedMemberAsAlive(t *testing.T) {
	ctx := context.Background()
	store := newMemStore()
	registry := NewRegistry(store, 45*time.Second, time.Hour, 4)
	call := seedCall(t, registry, store, "")

	if err := store.Delete(ctx, InstanceKey("")); err != nil {
		t.Fatalf("clear heartbeat: %v", err)
	}
	orphans, err := registry.FindOrphans(ctx)
	if err != nil {
		t.Fatalf("FindOrphans: %v", err)
	}
	if len(orphans) != 0 {
		t.Fatalf("reaped a call it could not judge: %+v", orphans)
	}
	_ = call
}

// Ending is a claim, so a call reaped by two instances at once is announced once.
func TestEndReportsWhoActuallyEndedTheCall(t *testing.T) {
	ctx := context.Background()
	store := newMemStore()
	registry := NewRegistry(store, 45*time.Second, time.Hour, 4)
	call := seedCall(t, registry, store, "instance-a")

	first, err := registry.End(ctx, call)
	if err != nil {
		t.Fatalf("first End: %v", err)
	}
	if !first {
		t.Fatal("the first End did not claim the call")
	}

	second, err := registry.End(ctx, call)
	if err != nil {
		t.Fatalf("second End: %v", err)
	}
	if second {
		t.Fatal("two callers both claimed the same ending; call.ended would be published twice")
	}
}

// The scan matches the member hash and the conversation claim as well as the
// call record, and only the record names a call.
func TestCallIDFromKeyIgnoresTheCompanionKeys(t *testing.T) {
	for _, tc := range []struct {
		key  string
		want string
		ok   bool
	}{
		{"call:abc", "abc", true},
		{"call:abc:members", "", false},
		{"call:abc:joined", "", false},
		{"call:conv:conv-1", "", false},
		{"presence:google_1", "", false},
		{"call:", "", false},
	} {
		got, ok := callIDFromKey(tc.key)
		if ok != tc.ok || got != tc.want {
			t.Fatalf("callIDFromKey(%q) = (%q,%v), want (%q,%v)", tc.key, got, ok, tc.want, tc.ok)
		}
	}
}
