package wsapi

import (
	"testing"

	"github.com/coder/websocket"

	"datha-platform/realtime-service/internal/calls"
)

// The three owners of every group call in these tests. They are named so that
// `third` sorts last, because the mesh's pairing rule is lexicographic and a
// test that accidentally relied on insertion order would pass by luck.
const third = "google_3"

func trioChecker() stubChecker {
	return stubChecker{allow: true, participants: []string{caller, callee, third}}
}

// inviteGroup dials all three, places a group call and returns the live id.
func inviteGroup(t *testing.T, h *harness) (a, b, c *websocket.Conn, callID string) {
	t.Helper()
	a = h.dial(t, caller)
	waitFor(t, a, TypeReady)
	b = h.dial(t, callee)
	waitFor(t, b, TypeReady)
	c = h.dial(t, third)
	waitFor(t, c, TypeReady)

	send(t, a, TypeCallInvite, map[string]any{"conversation_id": "conv-1"})

	var ringing CallRingingPayload
	if err := DecodePayload(waitFor(t, a, TypeCallRinging), &ringing); err != nil {
		t.Fatalf("decode call.ringing: %v", err)
	}
	return a, b, c, ringing.CallID
}

// waitForParticipant reads until the named person's transition arrives.
//
// Several of these frames are in flight at once in a three-way call — each join
// is announced to everyone — so a test that read "the next call.participant"
// would assert against whichever one happened to be queued first.
func waitForParticipant(t *testing.T, conn *websocket.Conn, ownerID, state string) CallParticipantPayload {
	t.Helper()
	for i := 0; i < 10; i++ {
		var payload CallParticipantPayload
		if err := DecodePayload(waitFor(t, conn, TypeCallParticipant), &payload); err != nil {
			t.Fatalf("decode call.participant: %v", err)
		}
		if payload.OwnerID == ownerID && payload.State == state {
			return payload
		}
	}
	t.Fatalf("no call.participant saying %s %s arrived", ownerID, state)
	return CallParticipantPayload{}
}

func TestGroupInviteRingsEveryoneElseWithNoSDP(t *testing.T) {
	h := newHarness(t, trioChecker(), 5)
	a, b, c, callID := inviteGroup(t, h)
	_ = a

	for _, conn := range []*websocket.Conn{b, c} {
		var incoming CallIncomingPayload
		if err := DecodePayload(waitFor(t, conn, TypeCallIncoming), &incoming); err != nil {
			t.Fatalf("decode call.incoming: %v", err)
		}
		if incoming.CallID != callID {
			t.Fatalf("call id = %q, want %q", incoming.CallID, callID)
		}
		// A mesh has no single peer to have made an offer, so the ring carries
		// none. A client answers with call.join and negotiates per pair after.
		if len(incoming.SDP) != 0 {
			t.Fatalf("sdp = %s, want a group ring to carry none", incoming.SDP)
		}
		if len(incoming.Participants) != 3 {
			t.Fatalf("participants = %v, want all three", incoming.Participants)
		}
	}
}

func TestGroupInviteCarryingAnSDPIsRefused(t *testing.T) {
	// Offering one description to everybody is not a mesh. Refused rather than
	// ignored, so a client sending it is told instead of silently losing it.
	h := newHarness(t, trioChecker(), 5)
	conn := h.dial(t, caller)
	waitFor(t, conn, TypeReady)

	send(t, conn, TypeCallInvite, map[string]any{
		"conversation_id": "conv-1",
		"sdp":             offer(),
	})
	expectError(t, conn, "bad_frame")
}

func TestInviteIsRefusedWhenTheConversationIsBiggerThanTheMesh(t *testing.T) {
	// Every peer holds N-1 connections and uplinks its own video N-1 times, so
	// this is a media ceiling. A group conversation holds 50.
	h := newHarness(t, stubChecker{
		allow:        true,
		participants: []string{caller, callee, third, "google_4", "google_5"},
	}, 5)
	conn := h.dial(t, caller)
	waitFor(t, conn, TypeReady)

	send(t, conn, TypeCallInvite, map[string]any{"conversation_id": "conv-1"})
	expectError(t, conn, "not_supported")
}

func TestGroupCallIsJoinedNotAnswered(t *testing.T) {
	h := newHarness(t, trioChecker(), 5)
	_, b, _, callID := inviteGroup(t, h)
	waitFor(t, b, TypeCallIncoming)

	// call.answer carries the answering description for one peer, and a mesh
	// has no one peer it could be for.
	send(t, b, TypeCallAnswer, map[string]any{"call_id": callID, "sdp": answerSDP()})
	expectError(t, b, "bad_frame")
}

// A 1:1 call used to refuse call.join outright, and this test asserted that.
//
// It is now allowed, because `call.answer` replies to an offer and somebody who
// signed in mid-ring never received one — their invite went out over core NATS
// before they had a socket. Answering is still the fast path when the offer is
// in hand; joining is the general one, and refusing it left a callee unable to
// take a call they could see ringing (dathq, 2026-09-16).
func Test1To1CallCanBeJoinedByAnyoneInvited(t *testing.T) {
	h := newHarness(t, pairChecker(), 5)
	callerConn, calleeConn, callID := invite(t, h)
	waitFor(t, calleeConn, TypeCallIncoming)

	send(t, calleeConn, TypeCallJoin, map[string]any{"call_id": callID})

	// The pair is announced to both ends, which is what lets them negotiate
	// from scratch rather than answering an offer that is no longer useful.
	for _, conn := range []*websocket.Conn{callerConn, calleeConn} {
		joined := waitForParticipant(t, conn, callee, ParticipantJoined)
		if len(joined.Participants) != 2 {
			t.Fatalf("participants = %v, want the caller and the joiner", joined.Participants)
		}
	}
}

func TestSomeoneNotInvitedStillCannotJoinA1To1Call(t *testing.T) {
	// Relaxing the 1:1 rule must not relax the authorization one. The invited
	// set is resolved from conversation membership and is the whole surface;
	// `third` is not in this pair's.
	h := newHarness(t, pairChecker(), 5)
	_, _, callID := invite(t, h)

	outsider := h.dial(t, third)
	waitFor(t, outsider, TypeReady)
	send(t, outsider, TypeCallJoin, map[string]any{"call_id": callID})
	expectError(t, outsider, "forbidden")
}

func TestJoiningAnnouncesTheParticipantToEveryoneInvited(t *testing.T) {
	h := newHarness(t, trioChecker(), 5)
	a, b, c, callID := inviteGroup(t, h)
	waitFor(t, b, TypeCallIncoming)
	waitFor(t, c, TypeCallIncoming)

	send(t, b, TypeCallJoin, map[string]any{"call_id": callID})

	// It reaches the person still ringing too: they need to see the room
	// filling up before they decide.
	for _, conn := range []*websocket.Conn{a, b, c} {
		joined := waitForParticipant(t, conn, callee, ParticipantJoined)
		// The full joined set, not a delta: core NATS is fire-and-forget, so a
		// client that missed a frame re-syncs from the next one.
		if len(joined.Participants) != 2 {
			t.Fatalf("participants = %v, want the caller and the joiner", joined.Participants)
		}
	}
}

func TestOnlyOneTabOfOnePersonWinsTheJoin(t *testing.T) {
	h := newHarness(t, trioChecker(), 5)
	_, b, _, callID := inviteGroup(t, h)
	waitFor(t, b, TypeCallIncoming)

	second := h.dial(t, callee)
	waitFor(t, second, TypeReady)

	send(t, b, TypeCallJoin, map[string]any{"call_id": callID})
	waitForParticipant(t, b, callee, ParticipantJoined)

	send(t, second, TypeCallJoin, map[string]any{"call_id": callID})
	var ended CallEndedPayload
	if err := DecodePayload(waitFor(t, second, TypeCallEnded), &ended); err != nil {
		t.Fatalf("decode call.ended: %v", err)
	}
	if ended.Reason != calls.ReasonAnsweredElsewhere {
		t.Fatalf("reason = %q, want answered_elsewhere", ended.Reason)
	}
}

func TestJoinFromSomeoneOutsideTheCallIsRefused(t *testing.T) {
	h := newHarness(t, trioChecker(), 5)
	_, _, _, callID := inviteGroup(t, h)

	// The checker allows this conversation, but the invited set was fixed when
	// the call was created and is never widened.
	outsider := h.dial(t, "google_9")
	waitFor(t, outsider, TypeReady)
	send(t, outsider, TypeCallJoin, map[string]any{"call_id": callID})
	expectError(t, outsider, "forbidden")
}

// --- targeted signaling: the authorization surface the mesh adds ------------

func TestICEInAGroupCallRequiresATarget(t *testing.T) {
	// A 1:1 call derives the peer, and deriving it is what made relaying safe.
	// A mesh cannot derive one, so the frame must name it.
	h := newHarness(t, trioChecker(), 5)
	a, _, _, callID := inviteGroup(t, h)

	send(t, a, TypeCallICE, map[string]any{
		"call_id":   callID,
		"candidate": candidate(),
	})
	expectError(t, a, "bad_frame")
}

func TestICEIsRelayedOnlyToTheNamedParticipant(t *testing.T) {
	h := newHarness(t, trioChecker(), 5)
	a, b, c, callID := inviteGroup(t, h)
	waitFor(t, b, TypeCallIncoming)
	waitFor(t, c, TypeCallIncoming)

	send(t, a, TypeCallICE, map[string]any{
		"call_id":   callID,
		"candidate": candidate(),
		"to":        callee,
	})

	var relayed CallICEPayload
	if err := DecodePayload(waitFor(t, b, TypeCallICE), &relayed); err != nil {
		t.Fatalf("decode call.ice: %v", err)
	}
	if relayed.From != caller {
		t.Fatalf("from = %q, want it stamped as %q", relayed.From, caller)
	}
	if relayed.To != callee {
		t.Fatalf("to = %q, want %q", relayed.To, callee)
	}

	// And nobody else in the room sees it. In a mesh each pair negotiates its
	// own connection, so a candidate broadcast to the room is both wrong and a
	// leak of one pair's network paths to a third party.
	if got := drain(t, c, TypeCallICE); got {
		t.Fatal("a candidate addressed to one participant reached another")
	}
}

func TestICETargetedAtSomeoneOutsideTheCallIsRefused(t *testing.T) {
	// The whole point of the slice: a client names its target now, so the name
	// is checked against the invited set instead of being derived.
	h := newHarness(t, trioChecker(), 5)
	a, _, _, callID := inviteGroup(t, h)

	send(t, a, TypeCallICE, map[string]any{
		"call_id":   callID,
		"candidate": candidate(),
		"to":        "google_9",
	})
	expectError(t, a, "forbidden")
}

func TestICETargetedAtYourselfIsRefused(t *testing.T) {
	h := newHarness(t, trioChecker(), 5)
	a, _, _, callID := inviteGroup(t, h)

	send(t, a, TypeCallICE, map[string]any{
		"call_id":   callID,
		"candidate": candidate(),
		"to":        caller,
	})
	expectError(t, a, "bad_frame")
}

func TestRenegotiationTargetedAtSomeoneOutsideTheCallIsRefused(t *testing.T) {
	h := newHarness(t, trioChecker(), 5)
	a, b, c, callID := inviteGroup(t, h)
	waitFor(t, b, TypeCallIncoming)
	waitFor(t, c, TypeCallIncoming)
	send(t, b, TypeCallJoin, map[string]any{"call_id": callID})
	waitForParticipant(t, a, callee, ParticipantJoined)

	send(t, a, TypeCallRenegotiate, map[string]any{
		"call_id": callID,
		"sdp":     offer(),
		"to":      "google_9",
	})
	expectError(t, a, "forbidden")
}

func TestRenegotiationCarriesTheFirstOfferOfEachMeshPair(t *testing.T) {
	h := newHarness(t, trioChecker(), 5)
	a, b, c, callID := inviteGroup(t, h)
	waitFor(t, b, TypeCallIncoming)
	waitFor(t, c, TypeCallIncoming)
	send(t, b, TypeCallJoin, map[string]any{"call_id": callID})
	waitForParticipant(t, a, callee, ParticipantJoined)

	send(t, a, TypeCallRenegotiate, map[string]any{
		"call_id": callID,
		"sdp":     offer(),
		"to":      callee,
	})

	var relayed CallRenegotiatePayload
	if err := DecodePayload(waitFor(t, b, TypeCallRenegotiate), &relayed); err != nil {
		t.Fatalf("decode call.renegotiate: %v", err)
	}
	if relayed.From != caller || relayed.To != callee {
		t.Fatalf("relayed = %+v, want from %s to %s", relayed, caller, callee)
	}
}

// --- leaving ---------------------------------------------------------------

func TestLeavingAGroupCallLeavesTheOthersTalking(t *testing.T) {
	h := newHarness(t, trioChecker(), 5)
	a, b, c, callID := inviteGroup(t, h)
	waitFor(t, b, TypeCallIncoming)
	waitFor(t, c, TypeCallIncoming)

	for _, ownerID := range []string{callee, third} {
		conn := b
		if ownerID == third {
			conn = c
		}
		send(t, conn, TypeCallJoin, map[string]any{"call_id": callID})
		waitForParticipant(t, conn, ownerID, ParticipantJoined)
	}

	send(t, c, TypeCallHangup, map[string]any{"call_id": callID})
	waitForParticipant(t, a, third, ParticipantLeft)
	// One person hanging up must not end the call for the two still talking —
	// this is the whole difference between a leave and a hang-up.
	if got := drain(t, a, TypeCallEnded); got {
		t.Fatal("one person leaving ended the call for everyone")
	}
}

func TestTheCallEndsWhenOnlyOnePersonIsLeft(t *testing.T) {
	h := newHarness(t, trioChecker(), 5)
	a, b, c, callID := inviteGroup(t, h)
	waitFor(t, b, TypeCallIncoming)
	waitFor(t, c, TypeCallIncoming)

	for _, ownerID := range []string{callee, third} {
		conn := b
		if ownerID == third {
			conn = c
		}
		send(t, conn, TypeCallJoin, map[string]any{"call_id": callID})
		waitForParticipant(t, conn, ownerID, ParticipantJoined)
	}

	send(t, c, TypeCallHangup, map[string]any{"call_id": callID})
	waitForParticipant(t, a, third, ParticipantLeft)
	send(t, b, TypeCallHangup, map[string]any{"call_id": callID})

	// A mesh of one is a person looking at themselves.
	var ended CallEndedPayload
	if err := DecodePayload(waitFor(t, a, TypeCallEnded), &ended); err != nil {
		t.Fatalf("decode call.ended: %v", err)
	}
	if ended.Reason != calls.ReasonEmpty {
		t.Fatalf("reason = %q, want empty", ended.Reason)
	}
}

func TestOneInviteeDecliningDoesNotCancelTheRingForTheOthers(t *testing.T) {
	h := newHarness(t, trioChecker(), 5)
	a, b, c, callID := inviteGroup(t, h)
	waitFor(t, b, TypeCallIncoming)
	waitFor(t, c, TypeCallIncoming)

	send(t, c, TypeCallHangup, map[string]any{"call_id": callID})
	waitForParticipant(t, a, third, ParticipantLeft)

	// The caller is still in the room alone and the call is still ringing, so
	// the remaining invitee can still pick up.
	send(t, b, TypeCallJoin, map[string]any{"call_id": callID})
	waitForParticipant(t, b, callee, ParticipantJoined)
}

// --- reconnect --------------------------------------------------------------

func TestADroppedSocketLeavesTheGroupCall(t *testing.T) {
	// Before this, a dropped tab sat in the call as a participant nobody could
	// hear until the Redis TTL — and in a mesh that is everyone else waiting on
	// a peer that is gone.
	h := newHarness(t, trioChecker(), 5)
	a, b, c, callID := inviteGroup(t, h)
	waitFor(t, b, TypeCallIncoming)
	waitFor(t, c, TypeCallIncoming)

	for _, ownerID := range []string{callee, third} {
		conn := b
		if ownerID == third {
			conn = c
		}
		send(t, conn, TypeCallJoin, map[string]any{"call_id": callID})
		waitForParticipant(t, conn, ownerID, ParticipantJoined)
	}

	_ = c.Close(websocket.StatusNormalClosure, "")

	left := waitForParticipant(t, a, third, ParticipantLeft)
	if len(left.Participants) != 2 {
		t.Fatalf("participants = %v, want the two still in the call", left.Participants)
	}
}

func TestADroppedSocketEndsA1To1Call(t *testing.T) {
	// The surviving peer sees exactly what a hang-up would have sent, rather
	// than a frozen tile and a call that only the TTL will clean up.
	h := newHarness(t, pairChecker(), 5)
	callerConn, calleeConn, callID := invite(t, h)
	waitFor(t, calleeConn, TypeCallIncoming)
	send(t, calleeConn, TypeCallAnswer, map[string]any{"call_id": callID, "sdp": answerSDP()})
	waitFor(t, callerConn, TypeCallAnswered)

	_ = calleeConn.Close(websocket.StatusNormalClosure, "")

	var ended CallEndedPayload
	if err := DecodePayload(waitFor(t, callerConn, TypeCallEnded), &ended); err != nil {
		t.Fatalf("decode call.ended: %v", err)
	}
	if ended.Reason != calls.ReasonHangup || ended.From != callee {
		t.Fatalf("ended = %+v, want a hangup from %s", ended, callee)
	}
}

func TestAReloadedTabKeepsItsPlaceWhenTheOldSocketCloses(t *testing.T) {
	// The whole reason the session id exists. A reload is a new connection
	// carrying the same tab, and the old socket's close arrives afterwards —
	// which must not evict the tab that just came back.
	h := newHarness(t, trioChecker(), 5)
	a, b, c, callID := inviteGroup(t, h)
	waitFor(t, b, TypeCallIncoming)
	waitFor(t, c, TypeCallIncoming)

	send(t, b, TypeCallJoin, map[string]any{"call_id": callID, "session_id": "tab-1"})
	waitForParticipant(t, a, callee, ParticipantJoined)

	// The same tab, reloaded: a new socket carrying the session it already had.
	reloaded := h.dial(t, callee)
	waitFor(t, reloaded, TypeReady)
	send(t, reloaded, TypeCallJoin, map[string]any{"call_id": callID, "session_id": "tab-1"})
	waitForParticipant(t, a, callee, ParticipantJoined)

	_ = b.Close(websocket.StatusNormalClosure, "")

	// The superseded close must be a no-op. If it evicts, the caller sees the
	// person leave a call they are sitting in.
	if got := drain(t, a, TypeCallParticipant); got {
		t.Fatal("the old socket's close evicted the reloaded tab")
	}
}

func TestASecondTabCannotStealAJoinedCall(t *testing.T) {
	// The takeover must not degrade into last-writer-wins: every tab rings, and
	// a second one joining would move a call in progress to the wrong window.
	h := newHarness(t, trioChecker(), 5)
	_, b, _, callID := inviteGroup(t, h)
	waitFor(t, b, TypeCallIncoming)
	send(t, b, TypeCallJoin, map[string]any{"call_id": callID, "session_id": "tab-1"})
	waitForParticipant(t, b, callee, ParticipantJoined)

	second := h.dial(t, callee)
	waitFor(t, second, TypeReady)
	send(t, second, TypeCallJoin, map[string]any{"call_id": callID, "session_id": "tab-2"})

	var ended CallEndedPayload
	if err := DecodePayload(waitFor(t, second, TypeCallEnded), &ended); err != nil {
		t.Fatalf("decode call.ended: %v", err)
	}
	if ended.Reason != calls.ReasonAnsweredElsewhere {
		t.Fatalf("reason = %q, want answered_elsewhere", ended.Reason)
	}
}

// Reloading after leaving a call must not ring you with the call you left.
//
// The connect-time ring added on 2026-09-16 asked only who was *currently* in
// the call, so anyone who had joined and then left looked exactly like someone
// who had never been told — and got rung again on every reload (dathq, the
// same day: "i've joined and leave, when i reload i still got the call
// notice").
func TestLeavingACallStopsItRingingOnReconnect(t *testing.T) {
	h := newHarness(t, trioChecker(), 5)
	_, b, c, callID := inviteGroup(t, h)
	waitFor(t, b, TypeCallIncoming)
	waitFor(t, c, TypeCallIncoming)

	// B joins so the call stays alive after they leave, then leaves.
	send(t, b, TypeCallJoin, map[string]any{"call_id": callID})
	waitForParticipant(t, b, callee, ParticipantJoined)
	send(t, c, TypeCallJoin, map[string]any{"call_id": callID})
	waitForParticipant(t, c, third, ParticipantJoined)
	send(t, b, TypeCallHangup, map[string]any{"call_id": callID})
	waitForParticipant(t, c, callee, ParticipantLeft)

	reconnected := h.dial(t, callee)
	waitFor(t, reconnected, TypeReady)
	expectNoFrame(t, reconnected, TypeCallIncoming)
}

// Declining is a decision too, and it has to outlive the socket that made it.
func TestDecliningACallStopsItRingingOnReconnect(t *testing.T) {
	h := newHarness(t, trioChecker(), 5)
	_, b, c, callID := inviteGroup(t, h)
	waitFor(t, b, TypeCallIncoming)
	waitFor(t, c, TypeCallIncoming)

	// C joins so the call outlives B's refusal; B declines without answering.
	send(t, c, TypeCallJoin, map[string]any{"call_id": callID})
	waitForParticipant(t, c, third, ParticipantJoined)
	send(t, b, TypeCallHangup, map[string]any{"call_id": callID})
	waitForParticipant(t, c, callee, ParticipantLeft)

	reconnected := h.dial(t, callee)
	waitFor(t, reconnected, TypeReady)
	expectNoFrame(t, reconnected, TypeCallIncoming)
}

// The person who has said nothing yet must still be rung — the whole point.
func TestSomeoneWhoHasNotDecidedIsStillRungOnReconnect(t *testing.T) {
	h := newHarness(t, trioChecker(), 5)
	_, b, c, callID := inviteGroup(t, h)
	waitFor(t, b, TypeCallIncoming)
	waitFor(t, c, TypeCallIncoming)

	send(t, b, TypeCallJoin, map[string]any{"call_id": callID})
	waitForParticipant(t, b, callee, ParticipantJoined)

	// C never answered and never refused: their phone is still ringing.
	reconnected := h.dial(t, third)
	waitFor(t, reconnected, TypeReady)
	var incoming CallIncomingPayload
	if err := DecodePayload(waitFor(t, reconnected, TypeCallIncoming), &incoming); err != nil {
		t.Fatalf("decode call.incoming: %v", err)
	}
	if incoming.CallID != callID {
		t.Fatalf("rang for %q, want %q", incoming.CallID, callID)
	}
}
