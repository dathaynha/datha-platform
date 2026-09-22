package hub

import (
	"errors"
	"sync"
	"testing"
)

type fakeSub struct {
	subject      string
	unsubscribed bool
	bus          *fakeBus
}

func (s *fakeSub) Unsubscribe() error {
	s.unsubscribed = true
	s.bus.mu.Lock()
	delete(s.bus.handlers, s.subject)
	s.bus.mu.Unlock()
	return nil
}

type fakeBus struct {
	mu         sync.Mutex
	handlers   map[string]func([]byte)
	published  []string
	subscribes int
	failOn     string
}

func newFakeBus() *fakeBus {
	return &fakeBus{handlers: map[string]func([]byte){}}
}

func (b *fakeBus) Subscribe(subject string, handler func([]byte)) (Subscription, error) {
	if subject == b.failOn {
		return nil, errors.New("boom")
	}
	b.mu.Lock()
	b.handlers[subject] = handler
	b.subscribes++
	b.mu.Unlock()
	return &fakeSub{subject: subject, bus: b}, nil
}

func (b *fakeBus) Publish(subject string, _ []byte) error {
	b.mu.Lock()
	b.published = append(b.published, subject)
	b.mu.Unlock()
	return nil
}

func (b *fakeBus) emit(subject string, data []byte) {
	b.mu.Lock()
	handler := b.handlers[subject]
	b.mu.Unlock()
	if handler != nil {
		handler(data)
	}
}

type fakeConn struct {
	id      string
	ownerID string
	mu      sync.Mutex
	frames  [][]byte
}

func (c *fakeConn) ID() string      { return c.id }
func (c *fakeConn) OwnerID() string { return c.ownerID }
func (c *fakeConn) Send(data []byte) {
	c.mu.Lock()
	c.frames = append(c.frames, data)
	c.mu.Unlock()
}
func (c *fakeConn) count() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.frames)
}

func TestAddSubscribesOwnerSubjectAndDelivers(t *testing.T) {
	bus := newFakeBus()
	h := New(bus, 5)
	c := &fakeConn{id: "c1", ownerID: "google_1"}

	if err := h.Add(c); err != nil {
		t.Fatalf("Add: %v", err)
	}
	if !h.Subscribed("c1", OwnerSubject("google_1")) {
		t.Fatal("connection was not subscribed to its owner subject")
	}

	bus.emit(OwnerSubject("google_1"), []byte(`{"t":"message.new"}`))
	if got := c.count(); got != 1 {
		t.Fatalf("frames delivered = %d, want 1", got)
	}
}

func TestOwnerFanoutReachesEveryTabOnce(t *testing.T) {
	bus := newFakeBus()
	h := New(bus, 5)
	a := &fakeConn{id: "c1", ownerID: "google_1"}
	b := &fakeConn{id: "c2", ownerID: "google_1"}
	for _, c := range []*fakeConn{a, b} {
		if err := h.Add(c); err != nil {
			t.Fatalf("Add: %v", err)
		}
	}

	// Two tabs, one subscription: the subject is shared, not duplicated.
	if bus.subscribes != 1 {
		t.Fatalf("bus subscriptions = %d, want 1", bus.subscribes)
	}

	bus.emit(OwnerSubject("google_1"), []byte(`{"t":"unread.added"}`))
	if a.count() != 1 || b.count() != 1 {
		t.Fatalf("frames = (%d, %d), want (1, 1)", a.count(), b.count())
	}
}

func TestRemoveUnsubscribesOnlyWhenLastMemberLeaves(t *testing.T) {
	bus := newFakeBus()
	h := New(bus, 5)
	a := &fakeConn{id: "c1", ownerID: "google_1"}
	b := &fakeConn{id: "c2", ownerID: "google_1"}
	_ = h.Add(a)
	_ = h.Add(b)

	h.Remove("c1")
	bus.emit(OwnerSubject("google_1"), []byte(`{"t":"message.new"}`))
	if b.count() != 1 {
		t.Fatalf("remaining tab got %d frames, want 1", b.count())
	}
	if h.Subjects() != 1 {
		t.Fatalf("subjects = %d, want 1 while a tab remains", h.Subjects())
	}

	h.Remove("c2")
	if h.Subjects() != 0 {
		t.Fatalf("subjects = %d after last tab left, want 0", h.Subjects())
	}
	if h.Connections() != 0 {
		t.Fatalf("connections = %d, want 0", h.Connections())
	}
}

func TestAddEnforcesPerOwnerCap(t *testing.T) {
	h := New(newFakeBus(), 2)
	for i, id := range []string{"c1", "c2"} {
		if err := h.Add(&fakeConn{id: id, ownerID: "google_1"}); err != nil {
			t.Fatalf("Add %d: %v", i, err)
		}
	}
	err := h.Add(&fakeConn{id: "c3", ownerID: "google_1"})
	if !errors.Is(err, ErrTooManyConnections) {
		t.Fatalf("error = %v, want ErrTooManyConnections", err)
	}
	if h.Connections() != 2 {
		t.Fatalf("connections = %d, want 2", h.Connections())
	}
}

func TestAddRollsBackWhenSubscribeFails(t *testing.T) {
	bus := newFakeBus()
	bus.failOn = OwnerSubject("google_1")
	h := New(bus, 5)

	if err := h.Add(&fakeConn{id: "c1", ownerID: "google_1"}); err == nil {
		t.Fatal("Add should fail when the bus subscription fails")
	}
	// A half-registered connection would be fed nothing and never cleaned up.
	if h.Connections() != 0 {
		t.Fatalf("connections = %d after failed Add, want 0", h.Connections())
	}
	if h.Subjects() != 0 {
		t.Fatalf("subjects = %d after failed Add, want 0", h.Subjects())
	}
}

func TestUnsubscribeStopsDelivery(t *testing.T) {
	bus := newFakeBus()
	h := New(bus, 5)
	c := &fakeConn{id: "c1", ownerID: "google_1"}
	_ = h.Add(c)

	subject := ConversationSubject("conv-1")
	if err := h.Subscribe("c1", subject); err != nil {
		t.Fatalf("Subscribe: %v", err)
	}
	bus.emit(subject, []byte(`{"t":"typing"}`))
	if c.count() != 1 {
		t.Fatalf("frames = %d, want 1", c.count())
	}

	h.Unsubscribe("c1", subject)
	bus.emit(subject, []byte(`{"t":"typing"}`))
	if c.count() != 1 {
		t.Fatalf("frames = %d after unsubscribe, want 1", c.count())
	}
}

func TestSendToOwnerBypassesTheBus(t *testing.T) {
	bus := newFakeBus()
	h := New(bus, 5)
	c := &fakeConn{id: "c1", ownerID: "google_1"}
	_ = h.Add(c)

	if sent := h.SendToOwner("google_1", []byte(`{"t":"ready"}`)); sent != 1 {
		t.Fatalf("sent = %d, want 1", sent)
	}
	if len(bus.published) != 0 {
		t.Fatalf("published %v, want nothing on the bus", bus.published)
	}
}

func TestSubjectNames(t *testing.T) {
	cases := map[string]string{
		OwnerSubject("google_1"):        "rt.owner.google_1",
		PresenceSubject("google_1"):     "rt.presence.google_1",
		ConversationSubject("conv-abc"): "rt.conv.conv-abc",
	}
	for got, want := range cases {
		if got != want {
			t.Errorf("subject = %q, want %q", got, want)
		}
	}
}
