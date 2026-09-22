// Package hub is the connection registry and the routing table in one: the set
// of bus subjects this instance subscribes to *is* the routing table, so no
// instance needs a shared connection table and no load balancer needs sticky
// sessions.
package hub

import (
	"errors"
	"fmt"
	"log/slog"
	"sync"
)

// Subscription is the part of a bus subscription the hub owns.
type Subscription interface {
	Unsubscribe() error
}

// Bus is the core-NATS surface the hub needs. Core, not JetStream: these frames
// are transport, not the record, so a dropped one self-heals on the client's
// next resync — a durable consumer would redeliver stale frames on reconnect.
type Bus interface {
	Subscribe(subject string, handler func(data []byte)) (Subscription, error)
	Publish(subject string, data []byte) error
}

// Conn is one client socket, as far as routing is concerned.
type Conn interface {
	ID() string
	OwnerID() string
	// Send must not block: a slow client may never stall fanout for everyone
	// else, so implementations drop frames rather than wait.
	Send(data []byte)
}

// ErrTooManyConnections is returned when an owner is over the multi-tab cap.
var ErrTooManyConnections = errors.New("too many connections for owner")

type subjectSub struct {
	sub     Subscription
	members map[string]struct{} // connection ids
}

// Hub tracks connections and their subject subscriptions.
type Hub struct {
	mu          sync.Mutex
	bus         Bus
	maxPerOwner int
	conns       map[string]Conn                // connID → conn
	byOwner     map[string]map[string]struct{} // ownerID → connIDs
	subjects    map[string]*subjectSub         // subject → subscription + members
	connSubject map[string]map[string]struct{} // connID → subjects
}

// New builds a hub over the given bus. maxPerOwner ≤ 0 means unlimited.
func New(bus Bus, maxPerOwner int) *Hub {
	return &Hub{
		bus:         bus,
		maxPerOwner: maxPerOwner,
		conns:       map[string]Conn{},
		byOwner:     map[string]map[string]struct{}{},
		subjects:    map[string]*subjectSub{},
		connSubject: map[string]map[string]struct{}{},
	}
}

// OwnerSubject is where messenger-service publishes this owner's live frames.
func OwnerSubject(ownerID string) string { return "rt.owner." + ownerID }

// PresenceSubject carries one owner's presence transitions.
func PresenceSubject(ownerID string) string { return "rt.presence." + ownerID }

// ConversationSubject carries ephemeral, conversation-scoped frames (typing).
func ConversationSubject(conversationID string) string {
	return "rt.conv." + conversationID
}

// Add registers a connection and subscribes it to its own owner subject.
func (h *Hub) Add(c Conn) error {
	h.mu.Lock()
	owned := h.byOwner[c.OwnerID()]
	if h.maxPerOwner > 0 && len(owned) >= h.maxPerOwner {
		h.mu.Unlock()
		return fmt.Errorf("%w: %d", ErrTooManyConnections, len(owned))
	}
	h.conns[c.ID()] = c
	if owned == nil {
		owned = map[string]struct{}{}
		h.byOwner[c.OwnerID()] = owned
	}
	owned[c.ID()] = struct{}{}
	h.mu.Unlock()

	if err := h.Subscribe(c.ID(), OwnerSubject(c.OwnerID())); err != nil {
		h.Remove(c.ID())
		return fmt.Errorf("subscribe owner subject: %w", err)
	}
	return nil
}

// Remove drops a connection and unsubscribes every subject it was the last
// member of. Leaving a subscription behind would keep delivering frames to
// nobody, which is how socket services leak.
func (h *Hub) Remove(connID string) {
	h.mu.Lock()
	conn, ok := h.conns[connID]
	if !ok {
		h.mu.Unlock()
		return
	}
	delete(h.conns, connID)
	if owned := h.byOwner[conn.OwnerID()]; owned != nil {
		delete(owned, connID)
		if len(owned) == 0 {
			delete(h.byOwner, conn.OwnerID())
		}
	}
	var stale []Subscription
	for subject := range h.connSubject[connID] {
		entry := h.subjects[subject]
		if entry == nil {
			continue
		}
		delete(entry.members, connID)
		if len(entry.members) == 0 {
			stale = append(stale, entry.sub)
			delete(h.subjects, subject)
		}
	}
	delete(h.connSubject, connID)
	h.mu.Unlock()

	for _, sub := range stale {
		if err := sub.Unsubscribe(); err != nil {
			slog.Warn("unsubscribe failed", "error", err)
		}
	}
}

// Subscribe attaches a connection to a subject, creating the bus subscription
// on first use and reusing it afterwards — N sockets watching one owner cost
// one subscription, not N.
func (h *Hub) Subscribe(connID, subject string) error {
	h.mu.Lock()
	if _, ok := h.conns[connID]; !ok {
		h.mu.Unlock()
		return errors.New("unknown connection")
	}
	if entry, ok := h.subjects[subject]; ok {
		entry.members[connID] = struct{}{}
		h.trackLocked(connID, subject)
		h.mu.Unlock()
		return nil
	}
	// Placeholder first so a frame arriving mid-subscribe finds the entry.
	entry := &subjectSub{members: map[string]struct{}{connID: {}}}
	h.subjects[subject] = entry
	h.trackLocked(connID, subject)
	h.mu.Unlock()

	sub, err := h.bus.Subscribe(subject, func(data []byte) {
		h.deliver(subject, data)
	})
	if err != nil {
		h.mu.Lock()
		if current, ok := h.subjects[subject]; ok && current == entry {
			delete(h.subjects, subject)
		}
		delete(h.connSubject[connID], subject)
		h.mu.Unlock()
		return fmt.Errorf("bus subscribe %s: %w", subject, err)
	}

	h.mu.Lock()
	entry.sub = sub
	h.mu.Unlock()
	return nil
}

// Unsubscribe detaches one connection from a subject.
func (h *Hub) Unsubscribe(connID, subject string) {
	h.mu.Lock()
	entry := h.subjects[subject]
	if entry == nil {
		h.mu.Unlock()
		return
	}
	delete(entry.members, connID)
	delete(h.connSubject[connID], subject)
	var stale Subscription
	if len(entry.members) == 0 {
		stale = entry.sub
		delete(h.subjects, subject)
	}
	h.mu.Unlock()

	if stale != nil {
		if err := stale.Unsubscribe(); err != nil {
			slog.Warn("unsubscribe failed", "error", err)
		}
	}
}

// Publish sends a frame onto the bus.
func (h *Hub) Publish(subject string, data []byte) error {
	return h.bus.Publish(subject, data)
}

// SendToOwner delivers a frame to every socket this instance holds for an
// owner, without going through the bus. Used for frames the server generates
// for one client only, such as `ready`.
func (h *Hub) SendToOwner(ownerID string, data []byte) int {
	h.mu.Lock()
	targets := make([]Conn, 0, len(h.byOwner[ownerID]))
	for connID := range h.byOwner[ownerID] {
		if c, ok := h.conns[connID]; ok {
			targets = append(targets, c)
		}
	}
	h.mu.Unlock()

	for _, c := range targets {
		c.Send(data)
	}
	return len(targets)
}

// Connections reports how many sockets this instance holds.
func (h *Hub) Connections() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.conns)
}

// Subjects reports how many bus subscriptions are open.
func (h *Hub) Subjects() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.subjects)
}

// Subscribed reports whether a connection is attached to a subject.
func (h *Hub) Subscribed(connID, subject string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	_, ok := h.connSubject[connID][subject]
	return ok
}

func (h *Hub) trackLocked(connID, subject string) {
	subjects := h.connSubject[connID]
	if subjects == nil {
		subjects = map[string]struct{}{}
		h.connSubject[connID] = subjects
	}
	subjects[subject] = struct{}{}
}

func (h *Hub) deliver(subject string, data []byte) {
	h.mu.Lock()
	entry := h.subjects[subject]
	if entry == nil {
		h.mu.Unlock()
		return
	}
	targets := make([]Conn, 0, len(entry.members))
	for connID := range entry.members {
		if c, ok := h.conns[connID]; ok {
			targets = append(targets, c)
		}
	}
	h.mu.Unlock()

	for _, c := range targets {
		c.Send(data)
	}
}
