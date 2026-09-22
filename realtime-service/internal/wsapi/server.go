package wsapi

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"

	"datha-platform/realtime-service/internal/calls"
	"datha-platform/realtime-service/internal/chatauth"
	"datha-platform/realtime-service/internal/events"
	"datha-platform/realtime-service/internal/hub"
	"datha-platform/realtime-service/internal/metrics"
	"datha-platform/realtime-service/internal/presence"
)

// Timings groups the intervals the socket runs on.
type Timings struct {
	Ping              time.Duration
	PresenceHeartbeat time.Duration
	Typing            time.Duration
	// CallRing is how long an unanswered invite rings before it becomes a
	// missed call.
	CallRing time.Duration
}

// Server terminates client sockets and applies the frame protocol.
type Server struct {
	hub      *hub.Hub
	presence *presence.Tracker
	chat     chatauth.Checker
	calls    *calls.Registry
	events   *events.Publisher
	metrics  *metrics.Metrics
	timings  Timings
	now      func() time.Time

	// ringTimers holds the unanswered-invite timers this instance owns, so an
	// answer or a hang-up can cancel one before it publishes call.missed.
	callMu     sync.Mutex
	ringTimers map[string]*time.Timer

	// maxPresenceSubscriptions caps one client's presence subscriptions.
	// Clients subscribe to the owners currently visible in their list;
	// subscribing to everyone is what makes presence fanout quadratic.
	maxPresenceSubscriptions int
}

// NewServer wires the socket handler. A nil events publisher is fine: calls
// still connect, they just leave no history.
func NewServer(
	h *hub.Hub,
	tracker *presence.Tracker,
	chat chatauth.Checker,
	registry *calls.Registry,
	publisher *events.Publisher,
	m *metrics.Metrics,
	timings Timings,
) *Server {
	return &Server{
		hub:                      h,
		presence:                 tracker,
		chat:                     chat,
		calls:                    registry,
		events:                   publisher,
		metrics:                  m,
		timings:                  timings,
		now:                      time.Now,
		ringTimers:               map[string]*time.Timer{},
		maxPresenceSubscriptions: 200,
	}
}

// Handle upgrades a request and serves one client until it disconnects.
//
// Identity is the gateway-injected X-Owner-ID and nothing else: this service
// holds no JWT code, exactly like every other downstream. The gateway also
// validates Origin before proxying the upgrade — a WebSocket upgrade gets no
// CORS preflight, so that check cannot be done here after the fact.
func (s *Server) Handle(w http.ResponseWriter, r *http.Request) {
	ownerID := r.Header.Get("X-Owner-ID")
	if ownerID == "" {
		http.Error(w, `{"error":"Missing X-Owner-ID header"}`, http.StatusUnauthorized)
		return
	}

	socket, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// The gateway is the only legitimate front door and it has already
		// checked Origin; browsers cannot reach this port directly in any
		// deployment. Origin checking here would reject the proxy itself.
		InsecureSkipVerify: true,
	})
	if err != nil {
		slog.Warn("websocket accept failed", "error", err)
		return
	}

	c := newConn(uuid.NewString(), ownerID, socket, s.now)
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	if err := s.hub.Add(c); err != nil {
		if errors.Is(err, hub.ErrTooManyConnections) {
			_ = socket.Close(websocket.StatusPolicyViolation, "too many connections")
			return
		}
		slog.Error("hub add failed", "error", err)
		_ = socket.Close(websocket.StatusInternalError, "registry unavailable")
		return
	}
	s.metrics.Connections.Inc()

	defer func() {
		s.hub.Remove(c.ID())
		s.metrics.Connections.Dec()
		// Detached from the request context, which is already cancelled by the
		// time a socket closes — the peers still have to be told.
		released, cancelRelease := context.WithTimeout(context.WithoutCancel(ctx), callOpTimeout)
		s.releaseCalls(released, c)
		cancelRelease()
		s.teardownPresence(context.WithoutCancel(ctx), c)
		_ = socket.Close(websocket.StatusNormalClosure, "")
	}()

	go c.writeLoop(ctx)

	s.beat(ctx, c, presence.StateOnline)
	s.announcePresence(ctx, c.OwnerID())
	s.sendReady(ctx, c)
	s.ringPending(ctx, c)

	stop := s.startTickers(ctx, c)
	defer stop()

	s.readLoop(ctx, c, socket)
}

func (s *Server) startTickers(ctx context.Context, c *conn) func() {
	ping := time.NewTicker(s.timings.Ping)
	beat := time.NewTicker(s.timings.PresenceHeartbeat)

	go func() {
		defer ping.Stop()
		defer beat.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-c.done:
				return
			case <-ping.C:
				s.send(c, TypePing, map[string]any{})
			case <-beat.C:
				// Re-arms the Redis TTL. Presence is the absence of this, so a
				// crashed tab expires on its own without anyone reporting it.
				s.beat(ctx, c, c.currentState())
			}
		}
	}()

	return func() {
		ping.Stop()
		beat.Stop()
	}
}

func (s *Server) readLoop(ctx context.Context, c *conn, socket *websocket.Conn) {
	for {
		_, data, err := socket.Read(ctx)
		if err != nil {
			c.close()
			return
		}

		frame, err := Decode(data)
		if err != nil {
			// A malformed frame is the client's problem, never grounds for
			// dropping a connection that may be carrying a call.
			c.Send(EncodeError("bad_frame", "frame could not be decoded"))
			continue
		}
		s.metrics.Frames.WithLabelValues(frame.T, metrics.DirectionIn).Inc()

		if allowed, refusedBy := c.limiter.allow(frame.T); !allowed {
			s.metrics.RateLimited.WithLabelValues(refusedBy, frame.T).Inc()
			// Told once per second, not once per dropped frame: answering a
			// flood frame for frame would turn it into an outbound one. The
			// socket stays open — it may be carrying a call.
			if c.limiter.shouldNotice() {
				c.Send(EncodeError("rate_limited", "too many frames; slow down"))
				slog.Warn("rate limited", "conn", c.ID(), "owner", c.OwnerID(), "bucket", refusedBy, "type", frame.T)
			}
			continue
		}

		if err := s.dispatch(ctx, c, frame); err != nil {
			if errors.Is(err, ErrUnknownType) {
				c.Send(EncodeError("unknown_type", "unsupported frame type: "+frame.T))
				continue
			}
			slog.Warn("frame handling failed", "type", frame.T, "owner", c.OwnerID(), "error", err)
			c.Send(EncodeError("frame_failed", "frame could not be handled"))
		}
	}
}

func (s *Server) dispatch(ctx context.Context, c *conn, frame Frame) error {
	switch frame.T {
	case TypePing:
		s.send(c, TypePong, map[string]any{})
		return nil

	case TypePresenceSubscribe:
		var payload PresenceSubscribePayload
		if err := DecodePayload(frame, &payload); err != nil {
			return err
		}
		return s.subscribePresence(ctx, c, payload.OwnerIDs)

	case TypeAway:
		c.setState(presence.StateAway)
		s.beat(ctx, c, presence.StateAway)
		s.announcePresence(ctx, c.OwnerID())
		return nil

	case TypeConversationOpen:
		var payload ConversationPayload
		if err := DecodePayload(frame, &payload); err != nil {
			return err
		}
		return s.openConversation(ctx, c, payload.ConversationID)

	case TypeConversationClose:
		var payload ConversationPayload
		if err := DecodePayload(frame, &payload); err != nil {
			return err
		}
		s.hub.Unsubscribe(c.ID(), hub.ConversationSubject(payload.ConversationID))
		c.untrackConversation(payload.ConversationID)
		return nil

	case TypeTypingStart, TypeTypingStop:
		var payload ConversationPayload
		if err := DecodePayload(frame, &payload); err != nil {
			return err
		}
		return s.relayTyping(c, payload.ConversationID, frame.T == TypeTypingStop)

	case TypeCallInvite:
		var payload CallInvitePayload
		if err := DecodePayload(frame, &payload); err != nil {
			return err
		}
		return s.handleInvite(ctx, c, payload)

	case TypeCallAnswer:
		var payload CallAnswerPayload
		if err := DecodePayload(frame, &payload); err != nil {
			return err
		}
		return s.handleAnswer(ctx, c, payload)

	case TypeCallJoin:
		var payload CallJoinPayload
		if err := DecodePayload(frame, &payload); err != nil {
			return err
		}
		return s.handleJoin(ctx, c, payload)

	case TypeCallRenegotiate:
		var payload CallRenegotiatePayload
		if err := DecodePayload(frame, &payload); err != nil {
			return err
		}
		return s.handleRenegotiate(ctx, c, payload)

	case TypeCallICE:
		var payload CallICEPayload
		if err := DecodePayload(frame, &payload); err != nil {
			return err
		}
		return s.handleICE(ctx, c, payload)

	case TypeCallHangup:
		var payload CallHangupPayload
		if err := DecodePayload(frame, &payload); err != nil {
			return err
		}
		return s.handleHangup(ctx, c, payload)

	default:
		return ErrUnknownType
	}
}

func (s *Server) subscribePresence(ctx context.Context, c *conn, ownerIDs []string) error {
	if len(ownerIDs) > s.maxPresenceSubscriptions {
		c.Send(EncodeError("too_many_owners", "presence.subscribe exceeds the per-client cap"))
		return nil
	}
	for _, ownerID := range ownerIDs {
		if ownerID == "" {
			continue
		}
		if err := s.hub.Subscribe(c.ID(), hub.PresenceSubject(ownerID)); err != nil {
			return err
		}
	}

	// Answer with current state immediately: a subscription only carries
	// *transitions*, so without this the client shows nothing until someone
	// happens to change state.
	states, err := s.presence.States(ctx, ownerIDs)
	if err != nil {
		return err
	}
	now := time.Now().UTC().Format(time.RFC3339)
	for ownerID, state := range states {
		s.send(c, TypePresence, PresenceEntry{OwnerID: ownerID, State: state, At: now})
	}
	return nil
}

func (s *Server) openConversation(ctx context.Context, c *conn, conversationID string) error {
	if conversationID == "" {
		c.Send(EncodeError("bad_frame", "conversation_id is required"))
		return nil
	}
	conversation, err := s.chat.Lookup(ctx, c.OwnerID(), conversationID)
	if err != nil {
		s.metrics.OpenRequests.WithLabelValues("error").Inc()
		return err
	}
	if conversation == nil {
		s.metrics.OpenRequests.WithLabelValues("denied").Inc()
		c.Send(EncodeError("forbidden", "not a participant of that conversation"))
		return nil
	}
	if err := s.hub.Subscribe(c.ID(), hub.ConversationSubject(conversationID)); err != nil {
		s.metrics.OpenRequests.WithLabelValues("error").Inc()
		return err
	}
	c.trackConversation(conversationID)
	s.metrics.OpenRequests.WithLabelValues("allowed").Inc()
	return nil
}

// relayTyping publishes a typing frame for one conversation.
//
// The sender must already hold an authorized subscription to that conversation
// (conversation.open), which is why no membership call happens per keystroke.
// `owner_id` is stamped from the connection: a client-supplied `from` is never
// trusted, per the service's design rules.
func (s *Server) relayTyping(c *conn, conversationID string, stopped bool) error {
	if !c.hasConversation(conversationID) {
		s.metrics.TypingRelay.WithLabelValues("denied").Inc()
		c.Send(EncodeError("forbidden", "open the conversation before typing in it"))
		return nil
	}

	payload := TypingPayload{
		ConversationID: conversationID,
		OwnerID:        c.OwnerID(),
		Until:          time.Now().UTC().Add(s.timings.Typing).Format(time.RFC3339),
		Stopped:        stopped,
	}
	data, err := Encode(TypeTyping, payload)
	if err != nil {
		s.metrics.TypingRelay.WithLabelValues("error").Inc()
		return err
	}
	if err := s.hub.Publish(hub.ConversationSubject(conversationID), data); err != nil {
		s.metrics.TypingRelay.WithLabelValues("error").Inc()
		return err
	}
	s.metrics.TypingRelay.WithLabelValues("ok").Inc()
	return nil
}

func (s *Server) sendReady(ctx context.Context, c *conn) {
	state, err := s.presence.State(ctx, c.OwnerID())
	if err != nil {
		slog.Warn("presence lookup for ready frame failed", "error", err)
		state = presence.StateOnline
	}
	now := time.Now().UTC()
	s.send(c, TypeReady, ReadyPayload{
		OwnerID:    c.OwnerID(),
		ServerTime: now.Format(time.RFC3339),
		Presence: []PresenceEntry{
			{OwnerID: c.OwnerID(), State: state, At: now.Format(time.RFC3339)},
		},
	})
}

// ringPending rings a socket for any live call it is already invited to.
//
// `call.incoming` is published over core NATS, which delivers to whoever is
// listening at that moment and to nobody else. Sign in while the phone is
// ringing and the frame is simply gone — and a call nobody has answered has no
// history row either, because that is written on the transition to active. So
// the caller sat waiting while the callee's screen stayed empty, for the whole
// 30 s ring (dathq, 2026-09-16).
//
// The fix is to read the state rather than replay the event, which is what
// click-to-join already does for an ongoing call. Deliberately **no SDP**: the
// caller's offer is stale by now and the ICE candidates that followed it went
// to the same lost subject, so answering it would connect nothing. Without one
// the client joins instead, and the pair negotiates fresh — the case
// CallIncomingPayload's own doc comment already described.
//
// Failure is logged, never fatal: a socket that cannot be told about a call it
// missed is still a working socket for everything else.
func (s *Server) ringPending(ctx context.Context, c *conn) {
	pending, err := s.calls.PendingFor(ctx, c.OwnerID())
	if err != nil {
		slog.Warn("pending call lookup failed", "owner", c.OwnerID(), "error", err)
		return
	}
	for _, call := range pending {
		s.send(c, TypeCallIncoming, CallIncomingPayload{
			CallID:         call.ID,
			ConversationID: call.ConversationID,
			From:           call.CallerID,
			Media:          call.Media,
			Participants:   call.Participants,
		})
	}
}

func (s *Server) beat(ctx context.Context, c *conn, state string) {
	if err := s.presence.Beat(ctx, c.OwnerID(), c.ID(), state); err != nil {
		s.metrics.PresenceBeats.WithLabelValues("error").Inc()
		slog.Warn("presence beat failed", "owner", c.OwnerID(), "error", err)
		return
	}
	s.metrics.PresenceBeats.WithLabelValues("ok").Inc()
}

// announcePresence publishes the owner's resolved state, so instances holding a
// subscriber for that owner forward it to their clients.
func (s *Server) announcePresence(ctx context.Context, ownerID string) {
	state, err := s.presence.State(ctx, ownerID)
	if err != nil {
		slog.Warn("presence state lookup failed", "owner", ownerID, "error", err)
		return
	}
	data, err := Encode(TypePresence, PresenceEntry{
		OwnerID: ownerID,
		State:   state,
		At:      time.Now().UTC().Format(time.RFC3339),
	})
	if err != nil {
		slog.Warn("presence frame encode failed", "error", err)
		return
	}
	if err := s.hub.Publish(hub.PresenceSubject(ownerID), data); err != nil {
		slog.Warn("presence publish failed", "owner", ownerID, "error", err)
	}
}

// teardownPresence clears this connection's key and re-announces, so the last
// tab closing makes the person offline while a second tab keeps them online.
func (s *Server) teardownPresence(ctx context.Context, c *conn) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	if err := s.presence.Clear(ctx, c.OwnerID(), c.ID()); err != nil {
		slog.Warn("presence clear failed", "owner", c.OwnerID(), "error", err)
	}
	s.announcePresence(ctx, c.OwnerID())
}

func (s *Server) send(c *conn, frameType string, payload any) {
	data, err := Encode(frameType, payload)
	if err != nil {
		slog.Warn("frame encode failed", "type", frameType, "error", err)
		return
	}
	s.metrics.Frames.WithLabelValues(frameType, metrics.DirectionOut).Inc()
	c.Send(data)
}
