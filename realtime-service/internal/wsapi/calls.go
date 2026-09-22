package wsapi

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"

	"datha-platform/realtime-service/internal/calls"
	"datha-platform/realtime-service/internal/events"
	"datha-platform/realtime-service/internal/hub"
	"datha-platform/realtime-service/internal/metrics"
)

// callOpTimeout bounds the Redis and publish work a timer fires off the back of
// a connection that may already be gone.
const callOpTimeout = 5 * time.Second

// handleInvite starts a call.
//
// Who is invited is resolved from conversation membership, never from the
// frame: this is the one place where a client-supplied recipient would turn the
// socket into a way to ring strangers. That rule is unchanged by groups — the
// invited set is simply everyone in the conversation rather than the one other
// person, and it is fixed here and never widened again.
func (s *Server) handleInvite(ctx context.Context, c *conn, payload CallInvitePayload) error {
	if payload.ConversationID == "" {
		c.Send(EncodeError("bad_frame", "conversation_id is required"))
		return nil
	}

	// An absent media kind is audio, so a client built before video keeps
	// working. A wrong one is refused rather than coerced: silently downgrading
	// a video invite to audio would ring the callee with no camera and no
	// explanation.
	media := payload.Media
	if media == "" {
		media = calls.MediaAudio
	}
	if !calls.ValidMedia(media) {
		c.Send(EncodeError("bad_frame", "media must be audio or video"))
		return nil
	}

	conversation, err := s.chat.Lookup(ctx, c.OwnerID(), payload.ConversationID)
	if err != nil {
		s.metrics.SignalingRelay.WithLabelValues("error").Inc()
		return err
	}
	if conversation == nil {
		s.metrics.SignalingRelay.WithLabelValues("denied").Inc()
		c.Send(EncodeError("forbidden", "not a participant of that conversation"))
		return nil
	}

	others := conversation.Other(c.OwnerID())
	switch {
	case len(others) == 0:
		c.Send(EncodeError("not_supported", "there is nobody else in that conversation"))
		return nil
	case len(others)+1 > s.calls.MaxParticipants():
		// A mesh gives every peer N-1 connections and N-1 uplinks of its own
		// video, so this is a media limit rather than a policy one — a group
		// conversation may hold far more people than a call can.
		c.Send(EncodeError("not_supported", fmt.Sprintf(
			"a call holds at most %d people; that conversation has %d",
			s.calls.MaxParticipants(), len(others)+1)))
		return nil
	}

	group := len(others) > 1
	// A 1:1 offer rides the ring, so the callee answers in one round trip. A
	// group has no single peer to offer to, so an SDP here would mean offering
	// one description to everybody — refused rather than ignored, so a client
	// sending one is told instead of silently having it dropped.
	switch {
	case !group && len(payload.SDP) == 0:
		c.Send(EncodeError("bad_frame", "sdp is required"))
		return nil
	case group && len(payload.SDP) > 0:
		c.Send(EncodeError("bad_frame", "a group invite carries no sdp; negotiate per pair after joining"))
		return nil
	}

	call := &calls.Call{
		ID:             uuid.NewString(),
		ConversationID: payload.ConversationID,
		CallerID:       c.OwnerID(),
		Participants:   append(others, c.OwnerID()),
		Media:          media,
	}
	if !group {
		call.CalleeID = others[0]
	}
	if err := s.calls.Create(ctx, call, c.ID(), payload.SessionID); err != nil {
		var busy calls.ErrConversationBusy
		if errors.As(err, &busy) {
			// One call per conversation, as every mainstream client does. The
			// id travels with the refusal because the useful answer is to join
			// that call — the client turns this straight into a `call.join`,
			// which also settles two people pressing Call in the same instant.
			s.metrics.SignalingRelay.WithLabelValues("denied").Inc()
			c.Send(EncodeErrorWithCall(
				"call_exists", "a call is already happening in that conversation", busy.CallID))
			return nil
		}
		s.metrics.SignalingRelay.WithLabelValues("error").Inc()
		return err
	}
	c.trackCall(call.ID)

	// Only the inviting tab needs the id; the caller's other tabs learn about
	// the call if and when it is answered.
	s.send(c, TypeCallRinging, CallRingingPayload{
		CallID:         call.ID,
		ConversationID: call.ConversationID,
		CalleeID:       call.CalleeID,
		Media:          call.Media,
		Participants:   call.Participants,
	})

	// Every tab of every invited person rings. Exactly one tab per person can
	// win their own join, and the rest are told `answered_elsewhere`.
	for _, ownerID := range call.Others(c.OwnerID()) {
		if err := s.publish(hub.OwnerSubject(ownerID), TypeCallIncoming, CallIncomingPayload{
			CallID:         call.ID,
			ConversationID: call.ConversationID,
			From:           call.CallerID,
			SDP:            payload.SDP,
			Media:          call.Media,
			Participants:   call.Participants,
		}); err != nil {
			s.metrics.SignalingRelay.WithLabelValues("error").Inc()
			return err
		}
	}

	s.armRingTimeout(call)
	s.metrics.SignalingRelay.WithLabelValues("ok").Inc()
	return nil
}

// handleAnswer accepts a ringing 1:1 call, first tab wins.
//
// A group call is joined with `call.join` instead, and is refused here rather
// than tolerated: this frame carries the answering description for one peer,
// and in a mesh there is no one peer it could be for.
func (s *Server) handleAnswer(ctx context.Context, c *conn, payload CallAnswerPayload) error {
	call, ok := s.loadCall(ctx, c, payload.CallID)
	if !ok {
		return nil
	}
	if call.IsGroup() {
		c.Send(EncodeError("bad_frame", "join a group call with call.join"))
		return nil
	}
	if c.OwnerID() != call.CalleeID {
		s.metrics.SignalingRelay.WithLabelValues("denied").Inc()
		c.Send(EncodeError("forbidden", "only the callee can answer"))
		return nil
	}
	if len(payload.SDP) == 0 {
		c.Send(EncodeError("bad_frame", "sdp is required"))
		return nil
	}

	// Whether this is the answer that starts the call, or the same tab
	// re-answering after a reload. `started` and the `connected` count belong to
	// the transition, not to every answer that arrives.
	ringing := call.Status == calls.StatusRinging
	won, err := s.calls.Join(ctx, call, c.OwnerID(), c.ID(), payload.SessionID)
	if err != nil {
		s.metrics.SignalingRelay.WithLabelValues("error").Inc()
		return err
	}
	if !won {
		// A sibling tab got there first. Told only to this connection, so the
		// winner is not disturbed.
		s.send(c, TypeCallEnded, CallEndedPayload{
			CallID: call.ID,
			Reason: calls.ReasonAnsweredElsewhere,
		})
		return nil
	}
	c.trackCall(call.ID)
	if err := s.calls.Activate(ctx, call); err != nil {
		s.metrics.SignalingRelay.WithLabelValues("error").Inc()
		return err
	}

	s.cancelRingTimeout(call.ID)

	if err := s.publish(hub.OwnerSubject(call.CallerID), TypeCallAnswered, CallAnsweredPayload{
		CallID: call.ID,
		From:   call.CalleeID,
		SDP:    payload.SDP,
	}); err != nil {
		s.metrics.SignalingRelay.WithLabelValues("error").Inc()
		return err
	}

	// Stops the callee's other tabs ringing. The winning tab receives this too
	// and must ignore it, because it holds the call as locally active.
	if err := s.publish(hub.OwnerSubject(call.CalleeID), TypeCallEnded, CallEndedPayload{
		CallID: call.ID,
		Reason: calls.ReasonAnsweredElsewhere,
	}); err != nil {
		slog.Warn("answered_elsewhere fanout failed", "call", call.ID, "error", err)
	}

	if ringing {
		s.publishCallEvent(events.TypeCallStarted, call, "", s.joinedOrWarn(ctx, call.ID), "")
		// "connected" here means signaling completed; ICE can still fail after
		// it, which the client reports as call.hangup{reason:"ice_failed"}.
		s.metrics.CallSetup.WithLabelValues("connected").Inc()
	}
	s.metrics.SignalingRelay.WithLabelValues("ok").Inc()
	return nil
}

// handleJoin accepts a group call, first tab of each person wins.
//
// It carries no SDP. A mesh is negotiated pair by pair *after* both ends know
// the other is in, and who offers in each pair is decided by `calls.Initiator`
// — the lexicographically lower owner id, which both sides compute for
// themselves from the participant list in this frame's fanout.
func (s *Server) handleJoin(ctx context.Context, c *conn, payload CallJoinPayload) error {
	call, ok := s.loadCall(ctx, c, payload.CallID)
	if !ok {
		return nil
	}
	/*
	 * A 1:1 call used to be refused here, on the grounds that it is answered
	 * with `call.answer`. That is the fast path, not the only one: `answer`
	 * carries the description that replies to the caller's offer, and someone
	 * who never received that offer has nothing to reply with.
	 *
	 * That is the ordinary case for a person who signs in while the phone is
	 * still ringing — the invite went out over core NATS before they had a
	 * socket, so it reached nobody. Joining is the general move: it puts them
	 * in the room and lets the pair negotiate from scratch, exactly as a mesh
	 * pair does. Refusing it left them unable to take a call they could see.
	 */
	if !call.HasParticipant(c.OwnerID()) {
		s.metrics.SignalingRelay.WithLabelValues("denied").Inc()
		c.Send(EncodeError("forbidden", "not invited to that call"))
		return nil
	}

	ringing := call.Status == calls.StatusRinging
	won, err := s.calls.Join(ctx, call, c.OwnerID(), c.ID(), payload.SessionID)
	if errors.Is(err, calls.ErrFull) {
		c.Send(EncodeError("not_supported", fmt.Sprintf(
			"that call already holds %d people", s.calls.MaxParticipants())))
		return nil
	}
	if err != nil {
		s.metrics.SignalingRelay.WithLabelValues("error").Inc()
		return err
	}
	if !won {
		s.send(c, TypeCallEnded, CallEndedPayload{
			CallID: call.ID,
			Reason: calls.ReasonAnsweredElsewhere,
		})
		return nil
	}
	c.trackCall(call.ID)
	if err := s.calls.Activate(ctx, call); err != nil {
		s.metrics.SignalingRelay.WithLabelValues("error").Inc()
		return err
	}
	s.cancelRingTimeout(call.ID)

	s.announceParticipant(ctx, call, c.OwnerID(), ParticipantJoined)

	// `started` fires once, on the transition — not for the third and fourth
	// person to arrive, which would write three more history rows for one call.
	if ringing {
		s.publishCallEvent(events.TypeCallStarted, call, "", s.joinedOrWarn(ctx, call.ID), "")
		s.metrics.CallSetup.WithLabelValues("connected").Inc()
	}
	s.metrics.SignalingRelay.WithLabelValues("ok").Inc()
	return nil
}

// announceParticipant tells everyone invited that one person arrived or left.
//
// It goes to the invited set rather than the joined set on purpose: someone
// still ringing needs to see the room filling up, and someone whose tab has
// just lost the join race needs to stop showing a call it is not in.
func (s *Server) announceParticipant(ctx context.Context, call *calls.Call, ownerID, state string) {
	members, err := s.calls.Members(ctx, call.ID)
	if err != nil {
		slog.Warn("member lookup failed", "call", call.ID, "error", err)
		return
	}
	joined := make([]string, 0, len(members))
	for _, member := range members {
		joined = append(joined, member.OwnerID)
	}

	payload := CallParticipantPayload{
		CallID:       call.ID,
		OwnerID:      ownerID,
		State:        state,
		Participants: joined,
	}
	for _, invited := range call.Participants {
		if err := s.publish(hub.OwnerSubject(invited), TypeCallParticipant, payload); err != nil {
			slog.Warn("call.participant fanout failed", "call", call.ID, "owner", invited, "error", err)
		}
	}
}

// resolveTarget decides which participant a signaling frame is for, and
// refuses the frame itself when it cannot.
//
// This is the authorization surface the mesh adds. Until now the peer was
// *derived* from a two-person call, and deriving it is exactly what made
// ringing — or trickling candidates at — a stranger impossible. A mesh has to
// let the client name its target, so the naming is checked instead:
//
//   - the sender must be in the call's invited set;
//   - a named target must be in it too, and must not be the sender;
//   - an unnamed target is derived, and only a 1:1 call can derive one.
//
// The 1:1 derivation is what keeps every client written before the mesh working
// with no change at all: it sends no `to`, and gets the behaviour it always had.
func (s *Server) resolveTarget(c *conn, call *calls.Call, to string) (string, bool) {
	if !call.HasParticipant(c.OwnerID()) {
		s.metrics.SignalingRelay.WithLabelValues("denied").Inc()
		c.Send(EncodeError("forbidden", "not a participant of that call"))
		return "", false
	}

	if to == "" {
		peer := call.Peer(c.OwnerID())
		if peer == "" {
			c.Send(EncodeError("bad_frame", "to is required in a group call"))
			return "", false
		}
		return peer, true
	}

	if to == c.OwnerID() {
		c.Send(EncodeError("bad_frame", "to cannot be yourself"))
		return "", false
	}
	if !call.HasParticipant(to) {
		s.metrics.SignalingRelay.WithLabelValues("denied").Inc()
		c.Send(EncodeError("forbidden", "that person is not in this call"))
		return "", false
	}
	return to, true
}

// handleICE relays one trickled candidate to one peer.
//
// The payload is opaque: this service never parses SDP or candidates, so it
// cannot leak or rewrite what the browsers negotiate. All it does is resolve
// the target, confirm membership and stamp `from`.
func (s *Server) handleICE(ctx context.Context, c *conn, payload CallICEPayload) error {
	call, ok := s.loadCall(ctx, c, payload.CallID)
	if !ok {
		return nil
	}
	target, ok := s.resolveTarget(c, call, payload.To)
	if !ok {
		return nil
	}
	if len(payload.Candidate) == 0 {
		c.Send(EncodeError("bad_frame", "candidate is required"))
		return nil
	}

	if err := s.publish(hub.OwnerSubject(target), TypeCallICE, CallICEPayload{
		CallID:    call.ID,
		Candidate: payload.Candidate,
		From:      c.OwnerID(),
		To:        target,
	}); err != nil {
		s.metrics.SignalingRelay.WithLabelValues("error").Inc()
		return err
	}
	s.metrics.SignalingRelay.WithLabelValues("ok").Inc()
	return nil
}

// handleRenegotiate relays a mid-call offer or answer to one other participant.
//
// Deliberately the same shape as handleICE: resolve the target, authorize,
// stamp `from`, relay verbatim. The SDP is opaque here — this service never
// learns whether a camera was added, only that two peers want to re-agree.
// Which half of the exchange a frame carries is inside the SDP, which is the
// client's business.
//
// Refused unless the call has been answered. A renegotiation while the call is
// still ringing would race the answer's own description exchange. In a group
// this frame also carries the *first* offer of each new pair, which is why the
// gate is the call being active rather than the pair being established.
func (s *Server) handleRenegotiate(ctx context.Context, c *conn, payload CallRenegotiatePayload) error {
	call, ok := s.loadCall(ctx, c, payload.CallID)
	if !ok {
		return nil
	}
	target, ok := s.resolveTarget(c, call, payload.To)
	if !ok {
		return nil
	}
	if len(payload.SDP) == 0 {
		c.Send(EncodeError("bad_frame", "sdp is required"))
		return nil
	}
	if call.AnsweredAt.IsZero() {
		c.Send(EncodeError("bad_frame", "call is not answered yet"))
		return nil
	}

	if err := s.publish(hub.OwnerSubject(target), TypeCallRenegotiate, CallRenegotiatePayload{
		CallID:         call.ID,
		SDP:            payload.SDP,
		From:           c.OwnerID(),
		To:             target,
		ScreenStreamID: payload.ScreenStreamID,
	}); err != nil {
		s.metrics.SignalingRelay.WithLabelValues("error").Inc()
		return err
	}
	s.metrics.SignalingRelay.WithLabelValues("ok").Inc()
	return nil
}

// handleHangup ends a call, or leaves one.
//
// In a 1:1 those are the same act. In a group they are not: one person hanging
// up leaves the others talking, so a departure is announced with
// `call.participant` and the call only ends when it runs out of people.
func (s *Server) handleHangup(ctx context.Context, c *conn, payload CallHangupPayload) error {
	call, ok := s.loadCall(ctx, c, payload.CallID)
	if !ok {
		return nil
	}
	if !call.HasParticipant(c.OwnerID()) {
		s.metrics.SignalingRelay.WithLabelValues("denied").Inc()
		c.Send(EncodeError("forbidden", "not a participant of that call"))
		return nil
	}

	reason := payload.Reason
	if reason != "" && !calls.ClientReasons[reason] {
		c.Send(EncodeError("bad_frame", "unsupported hangup reason"))
		return nil
	}
	if reason == "" {
		// Refusing a call that is still ringing is a decline, not a hang-up —
		// the distinction is what the callee's history row says.
		reason = calls.ReasonHangup
		if call.Status == calls.StatusRinging && c.OwnerID() != call.CallerID {
			reason = calls.ReasonDeclined
		}
	}

	switch {
	case reason == calls.ReasonICEFailed:
		s.metrics.ICEFailures.Inc()
		s.metrics.CallSetup.WithLabelValues("failed").Inc()
	case call.Status == calls.StatusRinging:
		s.metrics.CallSetup.WithLabelValues(reason).Inc()
	}

	c.untrackCall(call.ID)
	if call.IsGroup() {
		return s.leaveGroupCall(ctx, c, call, reason)
	}

	s.endCall(ctx, call, reason, c.OwnerID())
	s.metrics.SignalingRelay.WithLabelValues("ok").Inc()
	return nil
}

// leaveGroupCall removes one person, and ends the call only once it is spent.
//
// Two people is the floor: a mesh of one is a person looking at themselves, so
// the last pair leaving ends the call for whoever is left rather than stranding
// them in an empty room. A call still *ringing* is exempt — one invitee
// declining must not cancel the call for everyone still being rung.
func (s *Server) leaveGroupCall(ctx context.Context, c *conn, call *calls.Call, reason string) error {
	if err := s.calls.Leave(ctx, call.ID, c.OwnerID()); err != nil {
		s.metrics.SignalingRelay.WithLabelValues("error").Inc()
		return err
	}
	/*
	 * Leaving or declining is a decision about this call, and it has to outlive
	 * the socket that made it: the connect-time ring asks "has this person
	 * already decided", and without this a reload rang them again with a call
	 * they had just walked out of.
	 *
	 * Recorded for a leaver too, even though the joined set already covers
	 * them, so the rule reads as one thing rather than two that happen to
	 * overlap. Failure is logged, not fatal — an unrecorded dismissal costs an
	 * unwanted ring, and refusing the leave itself would be worse.
	 */
	if err := s.calls.Dismiss(ctx, call.ID, c.OwnerID()); err != nil {
		slog.Warn("dismissal not recorded", "call", call.ID, "owner", c.OwnerID(), "error", err)
	}
	s.announceParticipant(ctx, call, c.OwnerID(), ParticipantLeft)

	members, err := s.calls.Members(ctx, call.ID)
	if err != nil {
		s.metrics.SignalingRelay.WithLabelValues("error").Inc()
		return err
	}
	switch {
	case len(members) == 0:
		s.endCall(ctx, call, reason, c.OwnerID())
	case call.Status == calls.StatusActive && len(members) < 2:
		// Nobody asserted this one: the room simply emptied out, which is why
		// `empty` is a server reason a client may not send.
		s.endCall(ctx, call, calls.ReasonEmpty, "")
	}
	s.metrics.SignalingRelay.WithLabelValues("ok").Inc()
	return nil
}

// releaseCalls takes a closing connection out of every call it was in.
//
// Before this, a dropped socket left a member entry behind until the Redis TTL,
// so the others kept a tile for someone who could no longer hear them — and in
// a mesh that is three people waiting on a peer that is gone rather than one.
//
// The removal is conditional on this connection still holding the place. A tab
// that reloads is replaced by its own new connection, and that close arriving
// afterwards must be a no-op rather than an eviction: `LeaveIfHeldBy` answering
// false is the normal outcome for a superseded connection, not a failure.
func (s *Server) releaseCalls(ctx context.Context, c *conn) {
	for _, callID := range c.trackedCalls() {
		call, err := s.calls.Get(ctx, callID)
		if err != nil {
			// Already ended or expired: nothing to leave.
			continue
		}

		removed, err := s.calls.LeaveIfHeldBy(ctx, callID, c.OwnerID(), c.ID())
		if err != nil {
			slog.Warn("release call failed", "call", callID, "owner", c.OwnerID(), "error", err)
			continue
		}
		if !removed {
			continue
		}

		// A 1:1 call ends outright, and with the reason a hang-up would have
		// carried: there is no room left to stay in, and the wire behaviour for
		// the surviving peer is then identical whether the other side pressed
		// the button or lost its socket.
		if !call.IsGroup() {
			s.endCall(ctx, call, calls.ReasonHangup, c.OwnerID())
			continue
		}

		s.announceParticipant(ctx, call, c.OwnerID(), ParticipantLeft)
		members, err := s.calls.Members(ctx, callID)
		if err != nil {
			slog.Warn("member lookup failed", "call", callID, "error", err)
			continue
		}
		switch {
		case len(members) == 0:
			s.endCall(ctx, call, calls.ReasonHangup, c.OwnerID())
		case call.Status == calls.StatusActive && len(members) < 2:
			s.endCall(ctx, call, calls.ReasonEmpty, "")
		}
	}
}

// loadCall fetches a call and answers the client itself when it cannot.
func (s *Server) loadCall(ctx context.Context, c *conn, callID string) (*calls.Call, bool) {
	if callID == "" {
		c.Send(EncodeError("bad_frame", "call_id is required"))
		return nil, false
	}
	call, err := s.calls.Get(ctx, callID)
	if errors.Is(err, calls.ErrNotFound) {
		// Expired or already ended. Not an error: both peers may send a final
		// frame, and the second one arrives after the state is gone.
		c.Send(EncodeError("call_gone", "call is no longer live"))
		return nil, false
	}
	if err != nil {
		slog.Warn("call lookup failed", "call", callID, "error", err)
		c.Send(EncodeError("frame_failed", "call could not be loaded"))
		return nil, false
	}
	return call, true
}

// endCall tears one call down: both sides told, state cleared, record written.
func (s *Server) endCall(ctx context.Context, call *calls.Call, reason, from string) {
	s.cancelRingTimeout(call.ID)

	// Read before End clears it: the record of who was on the call is the one
	// thing that must outlive the call state.
	joined := s.joinedOrWarn(ctx, call.ID)

	/*
	 * Claim the ending before announcing it.
	 *
	 * A call can be ended by a hang-up, by the last socket closing and by
	 * another instance reaping it after a crash, and those can coincide.
	 * Consuming the record is atomic, so exactly one of them announces —-
	 * otherwise the same call publishes `call.ended` twice and the projection
	 * writes its history row twice.
	 */
	mine, err := s.calls.End(ctx, call)
	if err != nil {
		slog.Warn("call state cleanup failed", "call", call.ID, "error", err)
	}
	if !mine {
		return
	}

	payload := CallEndedPayload{CallID: call.ID, Reason: reason, From: from}
	for _, ownerID := range call.Participants {
		if err := s.publish(hub.OwnerSubject(ownerID), TypeCallEnded, payload); err != nil {
			slog.Warn("call.ended fanout failed", "call", call.ID, "owner", ownerID, "error", err)
		}
	}

	eventType := events.TypeCallEnded
	if reason == calls.ReasonMissed {
		eventType = events.TypeCallMissed
	}

	if eventType == events.TypeCallMissed && call.IsGroup() {
		// One event per person who did not answer. A bell rings for a person,
		// and "the group missed it" is not something anyone can be told — so a
		// single event with no owner is an event nobody receives.
		missed, err := s.calls.NeverJoined(ctx, call)
		if err != nil {
			slog.Warn("missed lookup failed", "call", call.ID, "error", err)
		}
		for _, ownerID := range missed {
			s.publishCallEvent(eventType, call, reason, joined, ownerID)
		}
	} else {
		s.publishCallEvent(eventType, call, reason, joined, "")
	}

}

// armRingTimeout starts the unanswered-invite timer.
//
// The timer lives on the instance that took the invite. If that instance dies
// mid-ring the call is never marked missed — the Redis TTL still reclaims the
// state, and nobody is left in a call, so the loss is one history row. Making
// this survivable would need a durable scheduler, which is not worth it for an
// event that means "nobody picked up".
func (s *Server) armRingTimeout(call *calls.Call) {
	callID := call.ID
	timer := time.AfterFunc(s.timings.CallRing, func() {
		s.ringTimeoutFired(callID)
	})

	s.callMu.Lock()
	s.ringTimers[callID] = timer
	s.callMu.Unlock()
}

func (s *Server) ringTimeoutFired(callID string) {
	s.callMu.Lock()
	delete(s.ringTimers, callID)
	s.callMu.Unlock()

	// Detached from the connection context on purpose: the caller may have
	// closed the tab, and the callee still needs to stop ringing.
	ctx, cancel := context.WithTimeout(context.Background(), callOpTimeout)
	defer cancel()

	call, err := s.calls.Get(ctx, callID)
	if err != nil {
		if !errors.Is(err, calls.ErrNotFound) {
			slog.Warn("ring timeout lookup failed", "call", callID, "error", err)
		}
		return
	}
	if call.Status != calls.StatusRinging {
		return
	}

	s.metrics.CallSetup.WithLabelValues("timeout").Inc()
	s.endCall(ctx, call, calls.ReasonMissed, "")
}

func (s *Server) cancelRingTimeout(callID string) {
	s.callMu.Lock()
	timer, ok := s.ringTimers[callID]
	delete(s.ringTimers, callID)
	s.callMu.Unlock()
	if ok {
		timer.Stop()
	}
}

// joinedOrWarn reads the ever-joined set, treating a failure as "unknown"
// rather than stopping the event: a history row with a thin participant list
// beats no history row at all.
func (s *Server) joinedOrWarn(ctx context.Context, callID string) []string {
	joined, err := s.calls.EverJoined(ctx, callID)
	if err != nil {
		slog.Warn("joined lookup failed", "call", callID, "error", err)
		return nil
	}
	return joined
}

// publishCallEvent writes the durable record. A failure here is logged, not
// returned: losing a history row must never drop a live call.
//
// `joined` is everyone who was on the call at any point, which is not the same
// as everyone invited and not the same as who was still there at the end.
// `missedOwner` names the one person a group's `missed` event is about.
func (s *Server) publishCallEvent(
	eventType string,
	call *calls.Call,
	reason string,
	joined []string,
	missedOwner string,
) {
	event := events.CallEvent{
		CallID:         call.ID,
		ConversationID: call.ConversationID,
		CallerID:       call.CallerID,
		CalleeID:       call.CalleeID,
		ParticipantIDs: call.Participants,
		JoinedIDs:      joined,
		MissedOwnerID:  missedOwner,
		Media:          call.Media,
		Reason:         reason,
		StartedAt:      call.StartedAt,
		AnsweredAt:     call.AnsweredAt,
	}
	if !call.AnsweredAt.IsZero() {
		event.DurationSeconds = int(s.now().UTC().Sub(call.AnsweredAt).Seconds())
	}
	if err := s.events.Publish(eventType, event); err != nil {
		slog.Warn("call event publish failed", "type", eventType, "call", call.ID, "error", err)
	}
}

// publish encodes a frame and puts it on the bus.
func (s *Server) publish(subject, frameType string, payload any) error {
	data, err := Encode(frameType, payload)
	if err != nil {
		return err
	}
	s.metrics.Frames.WithLabelValues(frameType, metrics.DirectionOut).Inc()
	return s.hub.Publish(subject, data)
}
