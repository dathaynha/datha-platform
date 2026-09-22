package wsapi

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// sendBuffer is how many frames may queue for one slow client before frames
// are dropped. Dropping is correct here: every live frame is transport, and the
// client resyncs from messenger-service after a gap. Blocking instead would let
// one stalled tab hold up fanout for everybody on this instance.
const sendBuffer = 64

// conn is one client socket. It satisfies hub.Conn.
type conn struct {
	id      string
	ownerID string
	socket  *websocket.Conn
	out     chan []byte

	closeOnce sync.Once
	done      chan struct{}

	// limiter bounds how fast this connection may send frames. Per connection
	// rather than per owner: it needs no shared state, and the multi-tab cap
	// already bounds how many a person can hold.
	limiter *connLimiter

	mu            sync.Mutex
	conversations map[string]struct{}
	// calls this connection currently holds a place in, so a closing socket can
	// take itself out of them. Without it a dropped tab sits in a call as a
	// participant nobody can hear until the Redis TTL reclaims it.
	calls   map[string]struct{}
	state   string
	dropped int
}

func newConn(id, ownerID string, socket *websocket.Conn, now func() time.Time) *conn {
	return &conn{
		id:            id,
		ownerID:       ownerID,
		socket:        socket,
		out:           make(chan []byte, sendBuffer),
		done:          make(chan struct{}),
		limiter:       newConnLimiter(now),
		conversations: map[string]struct{}{},
		calls:         map[string]struct{}{},
		state:         "online",
	}
}

func (c *conn) ID() string      { return c.id }
func (c *conn) OwnerID() string { return c.ownerID }

// Send never blocks — see sendBuffer.
func (c *conn) Send(data []byte) {
	select {
	case c.out <- data:
	case <-c.done:
	default:
		c.mu.Lock()
		c.dropped++
		dropped := c.dropped
		c.mu.Unlock()
		slog.Warn("dropped frame for slow client", "conn", c.id, "owner", c.ownerID, "dropped", dropped)
	}
}

// writeLoop is the only writer: a websocket connection allows exactly one
// concurrent writer, so every outbound frame funnels through here.
func (c *conn) writeLoop(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-c.done:
			return
		case data := <-c.out:
			if err := c.socket.Write(ctx, websocket.MessageText, data); err != nil {
				slog.Debug("socket write failed; closing", "conn", c.id, "error", err)
				c.close()
				return
			}
		}
	}
}

func (c *conn) close() {
	c.closeOnce.Do(func() { close(c.done) })
}

func (c *conn) trackConversation(id string) {
	c.mu.Lock()
	c.conversations[id] = struct{}{}
	c.mu.Unlock()
}

func (c *conn) untrackConversation(id string) {
	c.mu.Lock()
	delete(c.conversations, id)
	c.mu.Unlock()
}

func (c *conn) hasConversation(id string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	_, ok := c.conversations[id]
	return ok
}

func (c *conn) trackCall(id string) {
	c.mu.Lock()
	c.calls[id] = struct{}{}
	c.mu.Unlock()
}

func (c *conn) untrackCall(id string) {
	c.mu.Lock()
	delete(c.calls, id)
	c.mu.Unlock()
}

// trackedCalls copies the set, so the disconnect path can walk it without
// holding the lock across Redis and NATS work.
func (c *conn) trackedCalls() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	ids := make([]string, 0, len(c.calls))
	for id := range c.calls {
		ids = append(ids, id)
	}
	return ids
}

func (c *conn) setState(state string) {
	c.mu.Lock()
	c.state = state
	c.mu.Unlock()
}

func (c *conn) currentState() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.state
}
