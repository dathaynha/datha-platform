package calls

import (
	"context"
	"fmt"
	"time"
)

/*
Instance liveness, and why calls need it.

A call is closed by `releaseCalls`, which walks the connections a *process* is
tracking in its own memory. That is correct for a socket dropping and useless
for the process itself dying: an instance killed, crashed or rolled during a
deploy takes the only closer of its calls with it. The Redis record then expires
silently — expiry publishes nothing — so `call.ended` is never emitted, and
`messenger-service`'s projection keeps `ended_at NULL` **forever**. The thread
shows a call in progress for all time (dathq, 2026-09-15: "the data is wrong
when there's a bug happen").

The member hash cannot answer this on its own. Its fields are armed with the
call's TTL, so after a crash they are still there, holding connections that no
longer exist — "has no members" stays false until the whole call expires. What
is needed is a way to ask whether the *process* behind a member is still alive.

So every instance heartbeats a key with a short TTL and stamps its id on every
member it writes. A member whose instance key is gone is provably dead, and any
surviving instance can say so — no coordination, no leader, and correct with one
instance or twenty.
*/

// InstanceKeyPrefix namespaces instance heartbeats.
const InstanceKeyPrefix = "rt:instance:"

// InstanceKey names one instance's heartbeat.
func InstanceKey(instanceID string) string { return InstanceKeyPrefix + instanceID }

// Heartbeat keeps this instance's liveness key alive until ctx is done.
//
// The TTL is several times the interval on purpose: a missed beat under load
// must not declare a healthy instance dead and tear down live calls. Being slow
// to reap is harmless; reaping a live call is not.
func Heartbeat(
	ctx context.Context,
	store Store,
	instanceID string,
	interval, ttl time.Duration,
) error {
	if err := store.StealWithTTL(ctx, InstanceKey(instanceID), "1", ttl); err != nil {
		return fmt.Errorf("register instance %s: %w", instanceID, err)
	}
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				_ = store.StealWithTTL(ctx, InstanceKey(instanceID), "1", ttl)
			}
		}
	}()
	return nil
}

// LiveInstances reports which instance ids still hold a heartbeat.
func LiveInstances(ctx context.Context, store Store) (map[string]bool, error) {
	keys, err := store.KeysWithPrefix(ctx, InstanceKeyPrefix)
	if err != nil {
		return nil, fmt.Errorf("list instances: %w", err)
	}
	live := make(map[string]bool, len(keys))
	for _, key := range keys {
		live[key[len(InstanceKeyPrefix):]] = true
	}
	return live, nil
}

// Orphan is a call whose members all belong to instances that are gone.
type Orphan struct {
	Call *Call
	// Stranded names the members left behind, for the log: a call ending with
	// four stranded members is a crash, one with none is ordinary expiry.
	Stranded []string
}

// FindOrphans lists calls that no live instance is holding.
//
// Deliberately *all* members must be dead. A call with one live member and one
// stranded one is a call somebody is still sitting in, and the survivor's own
// socket close will resolve it through the ordinary path — which also publishes
// the right reason. Only a room nobody is left in is this function's business.
func (r *Registry) FindOrphans(ctx context.Context) ([]Orphan, error) {
	live, err := LiveInstances(ctx, r.store)
	if err != nil {
		return nil, err
	}

	keys, err := r.store.KeysWithPrefix(ctx, "call:")
	if err != nil {
		return nil, fmt.Errorf("list calls: %w", err)
	}

	orphans := make([]Orphan, 0)
	for _, key := range keys {
		callID, ok := callIDFromKey(key)
		if !ok {
			continue
		}
		call, err := r.Get(ctx, callID)
		if err != nil {
			// Ended or expired between the scan and the read: not ours.
			continue
		}
		members, err := r.Members(ctx, callID)
		if err != nil {
			continue
		}

		stranded := make([]string, 0, len(members))
		for _, member := range members {
			// A member written before instance ids existed cannot be judged, so
			// it is treated as alive: refusing to reap is the safe direction.
			if member.InstanceID == "" || live[member.InstanceID] {
				stranded = nil
				break
			}
			stranded = append(stranded, member.OwnerID)
		}
		if stranded == nil {
			continue
		}
		orphans = append(orphans, Orphan{Call: call, Stranded: stranded})
	}
	return orphans, nil
}

// callIDFromKey picks the call records out of a `call:*` scan, which also
// matches the member hash, the joined set and the conversation claim.
func callIDFromKey(key string) (string, bool) {
	const prefix = "call:"
	if len(key) <= len(prefix) || key[:len(prefix)] != prefix {
		return "", false
	}
	rest := key[len(prefix):]
	for i := 0; i < len(rest); i++ {
		if rest[i] == ':' {
			return "", false
		}
	}
	return rest, true
}
