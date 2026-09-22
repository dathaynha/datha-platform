// Package presence tracks who is online, in Redis with a TTL.
package presence

import (
	"context"
	"fmt"
	"time"
)

// States a client can be in. `offline` is never reported by a client: it is the
// absence of a heartbeat, because a crashed tab cannot send anything.
const (
	StateOnline  = "online"
	StateAway    = "away"
	StateOffline = "offline"
)

// Store is the Redis surface presence needs, kept narrow so tests need no server.
type Store interface {
	// SetWithTTL writes a connection's presence key and (re)arms its expiry.
	SetWithTTL(ctx context.Context, key, value string, ttl time.Duration) error
	// Delete is variadic only to match the shared kv client; presence clears
	// one connection's key at a time.
	Delete(ctx context.Context, keys ...string) error
	// KeysWithPrefix lists live keys under a prefix — expiry does the rest.
	KeysWithPrefix(ctx context.Context, prefix string) ([]string, error)
	GetAll(ctx context.Context, keys []string) (map[string]string, error)
}

// Key for one connection of one owner. Per-connection rather than per-owner so
// closing one of five tabs does not mark the person offline.
func Key(ownerID, connID string) string {
	return fmt.Sprintf("presence:%s:%s", ownerID, connID)
}

// KeyPrefix matches every connection of one owner.
func KeyPrefix(ownerID string) string {
	return fmt.Sprintf("presence:%s:", ownerID)
}

// Tracker writes and reads presence.
type Tracker struct {
	store Store
	ttl   time.Duration
}

// NewTracker builds a tracker. ttl must exceed the heartbeat interval, or a
// live tab flickers offline between beats.
func NewTracker(store Store, ttl time.Duration) *Tracker {
	return &Tracker{store: store, ttl: ttl}
}

// Beat records (or refreshes) one connection's presence.
func (t *Tracker) Beat(ctx context.Context, ownerID, connID, state string) error {
	if state != StateOnline && state != StateAway {
		return fmt.Errorf("presence state %q is not reportable by a client", state)
	}
	if err := t.store.SetWithTTL(ctx, Key(ownerID, connID), state, t.ttl); err != nil {
		return fmt.Errorf("presence beat: %w", err)
	}
	return nil
}

// Clear removes one connection's presence on a clean disconnect. A dirty one is
// handled by the TTL, which is the only mechanism that survives a crash.
func (t *Tracker) Clear(ctx context.Context, ownerID, connID string) error {
	if err := t.store.Delete(ctx, Key(ownerID, connID)); err != nil {
		return fmt.Errorf("presence clear: %w", err)
	}
	return nil
}

// State resolves one owner's presence across all their connections: online if
// any connection is online, away if all are away, offline if none are left.
func (t *Tracker) State(ctx context.Context, ownerID string) (string, error) {
	keys, err := t.store.KeysWithPrefix(ctx, KeyPrefix(ownerID))
	if err != nil {
		return "", fmt.Errorf("presence lookup: %w", err)
	}
	if len(keys) == 0 {
		return StateOffline, nil
	}
	values, err := t.store.GetAll(ctx, keys)
	if err != nil {
		return "", fmt.Errorf("presence read: %w", err)
	}
	state := StateOffline
	for _, v := range values {
		if v == StateOnline {
			return StateOnline, nil
		}
		if v == StateAway {
			state = StateAway
		}
	}
	return state, nil
}

// States resolves several owners at once — what the `ready` frame needs.
func (t *Tracker) States(ctx context.Context, ownerIDs []string) (map[string]string, error) {
	out := make(map[string]string, len(ownerIDs))
	for _, ownerID := range ownerIDs {
		state, err := t.State(ctx, ownerID)
		if err != nil {
			return nil, err
		}
		out[ownerID] = state
	}
	return out, nil
}
