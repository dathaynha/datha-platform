package wsapi

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/coder/websocket"

	"datha-platform/realtime-service/internal/calls"
)

// The two owners of every 1:1 call in these tests.
const (
	caller = "google_1"
	callee = "google_2"
)

func pairChecker() stubChecker {
	return stubChecker{allow: true, participants: []string{caller, callee}}
}

// offer is an opaque payload on purpose: this service relays SDP and never
// parses it, so the tests assert it survives byte for byte.
func offer() map[string]any {
	return map[string]any{"type": "offer", "sdp": "v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n"}
}

func answerSDP() map[string]any {
	return map[string]any{"type": "answer", "sdp": "v=0\r\na=recvonly\r\n"}
}

func candidate() map[string]any {
	return map[string]any{"candidate": "candidate:1 1 UDP 2130706431 10.0.0.1 54321 typ host"}
}

func errorPayload(t *testing.T, frame Frame) ErrorPayload {
	t.Helper()
	var payload ErrorPayload
	if err := DecodePayload(frame, &payload); err != nil {
		t.Fatalf("decode error frame: %v", err)
	}
	return payload
}

// expectNoFrame asserts a frame type does NOT arrive within a short window.
//
// Bounded deliberately, and short: an absence can only ever be asserted over
// some interval, and an unbounded wait for something that should never come
// would burn the whole test timeout and read as a hang rather than a failure.
func expectNoFrame(t *testing.T, conn *websocket.Conn, unwanted string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()

	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			return // the deadline passed with nothing unwanted: the assertion
		}
		frame, err := Decode(data)
		if err != nil {
			t.Fatalf("decode %s: %v", data, err)
		}
		if frame.T == unwanted {
			t.Fatalf("got a %q frame; it must not be sent here", unwanted)
		}
	}
}

// expectError asserts the next frame is a refusal with the given code.
//
// It reads with a short deadline and names what arrived instead, so removing
// one of these guards fails with "got call.answered, want error forbidden"
// rather than a bare read deadline that could mean anything.
func expectError(t *testing.T, conn *websocket.Conn, code string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()

	_, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("no frame arrived; want an error frame with code %q (read: %v)", code, err)
	}
	frame, err := Decode(data)
	if err != nil {
		t.Fatalf("decode %s: %v", data, err)
	}
	if frame.T != TypeError {
		t.Fatalf("got a %q frame, want an error frame with code %q", frame.T, code)
	}
	if got := errorPayload(t, frame).Code; got != code {
		t.Fatalf("code = %q, want %q", got, code)
	}
}

// invite dials both sides, places a call and returns the live call id.
func invite(t *testing.T, h *harness) (callerConn, calleeConn *websocket.Conn, callID string) {
	t.Helper()
	callerConn = h.dial(t, caller)
	waitFor(t, callerConn, TypeReady)
	calleeConn = h.dial(t, callee)
	waitFor(t, calleeConn, TypeReady)

	send(t, callerConn, TypeCallInvite, map[string]any{
		"conversation_id": "conv-1",
		"sdp":             offer(),
	})

	var ringing CallRingingPayload
	if err := DecodePayload(waitFor(t, callerConn, TypeCallRinging), &ringing); err != nil {
		t.Fatalf("decode call.ringing: %v", err)
	}
	return callerConn, calleeConn, ringing.CallID
}

func TestInviteResolvesTheCalleeFromMembershipAndRingsThem(t *testing.T) {
	h := newHarness(t, pairChecker(), 5)
	callerConn, calleeConn, callID := invite(t, h)
	_ = callerConn

	if callID == "" {
		t.Fatal("call.ringing carried no call id")
	}

	var incoming CallIncomingPayload
	if err := DecodePayload(waitFor(t, calleeConn, TypeCallIncoming), &incoming); err != nil {
		t.Fatalf("decode call.incoming: %v", err)
	}
	if incoming.CallID != callID {
		t.Fatalf("callee saw call %q, caller was told %q", incoming.CallID, callID)
	}
	// `from` is stamped by the server, never carried up by the client.
	if incoming.From != caller {
		t.Fatalf("from = %q, want %q", incoming.From, caller)
	}

	// The SDP must arrive exactly as it was sent: relayed, not parsed.
	want, _ := json.Marshal(offer())
	var got, expected map[string]any
	_ = json.Unmarshal(incoming.SDP, &got)
	_ = json.Unmarshal(want, &expected)
	if got["sdp"] != expected["sdp"] || got["type"] != expected["type"] {
		t.Fatalf("sdp = %v, want %v", got, expected)
	}
}

func TestInviteIsRefusedForANonParticipant(t *testing.T) {
	h := newHarness(t, stubChecker{allow: false}, 5)
	conn := h.dial(t, caller)
	waitFor(t, conn, TypeReady)

	send(t, conn, TypeCallInvite, map[string]any{"conversation_id": "conv-1", "sdp": offer()})
	if code := errorPayload(t, waitFor(t, conn, TypeError)).Code; code != "forbidden" {
		t.Fatalf("code = %q, want forbidden", code)
	}
}

func TestInviteRefusesAConversationWithNobodyElseInIt(t *testing.T) {
	// A conversation of three used to be refused here; it is a group call as of
	// phase 3 slice 1, and the group cases live in group_test.go. What is still
	// refused is a call with no second participant to ring.
	h := newHarness(t, stubChecker{allow: true, participants: []string{caller}}, 5)
	conn := h.dial(t, caller)
	waitFor(t, conn, TypeReady)

	send(t, conn, TypeCallInvite, map[string]any{"conversation_id": "conv-1", "sdp": offer()})
	if code := errorPayload(t, waitFor(t, conn, TypeError)).Code; code != "not_supported" {
		t.Fatalf("code = %q, want not_supported", code)
	}
}

func TestInviteRequiresAnSDP(t *testing.T) {
	h := newHarness(t, pairChecker(), 5)
	conn := h.dial(t, caller)
	waitFor(t, conn, TypeReady)

	send(t, conn, TypeCallInvite, map[string]any{"conversation_id": "conv-1"})
	if code := errorPayload(t, waitFor(t, conn, TypeError)).Code; code != "bad_frame" {
		t.Fatalf("code = %q, want bad_frame", code)
	}
}

func TestOnlyTheCalleeCanAnswer(t *testing.T) {
	h := newHarness(t, pairChecker(), 5)
	callerConn, _, callID := invite(t, h)

	// The caller answering their own invite would be a way to force a call
	// "connected" without the other side ever agreeing.
	send(t, callerConn, TypeCallAnswer, map[string]any{"call_id": callID, "sdp": answerSDP()})
	expectError(t, callerConn, "forbidden")
}

func TestAnswerReachesTheCallerWithTheAnsweringSDP(t *testing.T) {
	h := newHarness(t, pairChecker(), 5)
	callerConn, calleeConn, callID := invite(t, h)
	waitFor(t, calleeConn, TypeCallIncoming)

	send(t, calleeConn, TypeCallAnswer, map[string]any{"call_id": callID, "sdp": answerSDP()})

	var answered CallAnsweredPayload
	if err := DecodePayload(waitFor(t, callerConn, TypeCallAnswered), &answered); err != nil {
		t.Fatalf("decode call.answered: %v", err)
	}
	if answered.CallID != callID || answered.From != callee {
		t.Fatalf("answered = %+v, want call %s from %s", answered, callID, callee)
	}
	var sdp map[string]any
	_ = json.Unmarshal(answered.SDP, &sdp)
	if sdp["type"] != "answer" {
		t.Fatalf("sdp = %v, want the answering description", sdp)
	}
}

func TestAnsweringStopsTheCalleesOtherTabsRinging(t *testing.T) {
	h := newHarness(t, pairChecker(), 5)
	callerConn, firstTab, callID := invite(t, h)
	_ = callerConn
	waitFor(t, firstTab, TypeCallIncoming)

	// A second tab of the same person is also ringing — the invite goes to the
	// owner subject, not to one socket.
	secondTab := h.dial(t, callee)
	waitFor(t, secondTab, TypeReady)

	send(t, firstTab, TypeCallAnswer, map[string]any{"call_id": callID, "sdp": answerSDP()})

	var ended CallEndedPayload
	if err := DecodePayload(waitFor(t, secondTab, TypeCallEnded), &ended); err != nil {
		t.Fatalf("decode call.ended: %v", err)
	}
	if ended.Reason != "answered_elsewhere" {
		t.Fatalf("reason = %q, want answered_elsewhere", ended.Reason)
	}
}

func TestOnlyOneTabWinsTheAnswerRace(t *testing.T) {
	h := newHarness(t, pairChecker(), 5)
	callerConn, firstTab, callID := invite(t, h)
	_ = callerConn
	waitFor(t, firstTab, TypeCallIncoming)

	secondTab := h.dial(t, callee)
	waitFor(t, secondTab, TypeReady)

	send(t, firstTab, TypeCallAnswer, map[string]any{"call_id": callID, "sdp": answerSDP()})
	waitFor(t, firstTab, TypeCallEnded) // the answered_elsewhere fanout it must ignore

	send(t, secondTab, TypeCallAnswer, map[string]any{"call_id": callID, "sdp": answerSDP()})
	var ended CallEndedPayload
	if err := DecodePayload(waitFor(t, secondTab, TypeCallEnded), &ended); err != nil {
		t.Fatalf("decode call.ended: %v", err)
	}
	if ended.Reason != "answered_elsewhere" {
		t.Fatalf("reason = %q, want answered_elsewhere — a second answer must not renegotiate a live call", ended.Reason)
	}
}

func TestICEIsRelayedToThePeerWithFromStampedByTheServer(t *testing.T) {
	h := newHarness(t, pairChecker(), 5)
	callerConn, calleeConn, callID := invite(t, h)
	waitFor(t, calleeConn, TypeCallIncoming)

	// Trickle ICE starts before the answer, so a candidate must relay while the
	// call is still ringing. The forged `from` must be discarded.
	send(t, callerConn, TypeCallICE, map[string]any{
		"call_id":   callID,
		"candidate": candidate(),
		"from":      "google_impostor",
	})

	var ice CallICEPayload
	if err := DecodePayload(waitFor(t, calleeConn, TypeCallICE), &ice); err != nil {
		t.Fatalf("decode call.ice: %v", err)
	}
	if ice.From != caller {
		t.Fatalf("from = %q, want %q — a client-supplied from must never be echoed", ice.From, caller)
	}
	var relayed map[string]any
	_ = json.Unmarshal(ice.Candidate, &relayed)
	if relayed["candidate"] != candidate()["candidate"] {
		t.Fatalf("candidate = %v, want it relayed verbatim", relayed)
	}
}

func TestICEFromSomeoneOutsideTheCallIsRefused(t *testing.T) {
	h := newHarness(t, pairChecker(), 5)
	_, calleeConn, callID := invite(t, h)
	waitFor(t, calleeConn, TypeCallIncoming)

	// Knowing a call id must not be enough to inject signaling into it.
	outsider := h.dial(t, "google_9")
	waitFor(t, outsider, TypeReady)
	send(t, outsider, TypeCallICE, map[string]any{"call_id": callID, "candidate": candidate()})
	expectError(t, outsider, "forbidden")

	// And nothing reached the peer: a refusal that still relayed the candidate
	// would be worse than no refusal at all.
	relayCtx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	if _, data, err := calleeConn.Read(relayCtx); err == nil {
		t.Fatalf("callee received %s after an outsider's candidate", data)
	}
}

func TestHangupWhileRingingIsRecordedAsADecline(t *testing.T) {
	h := newHarness(t, pairChecker(), 5)
	callerConn, calleeConn, callID := invite(t, h)
	waitFor(t, calleeConn, TypeCallIncoming)

	send(t, calleeConn, TypeCallHangup, map[string]any{"call_id": callID})

	var ended CallEndedPayload
	if err := DecodePayload(waitFor(t, callerConn, TypeCallEnded), &ended); err != nil {
		t.Fatalf("decode call.ended: %v", err)
	}
	// "declined" and "hangup" are different rows in someone's history.
	if ended.Reason != "declined" || ended.From != callee {
		t.Fatalf("ended = %+v, want declined from the callee", ended)
	}
}

func TestHangupOfAnActiveCallIsAHangupNotADecline(t *testing.T) {
	h := newHarness(t, pairChecker(), 5)
	callerConn, calleeConn, callID := invite(t, h)
	waitFor(t, calleeConn, TypeCallIncoming)
	send(t, calleeConn, TypeCallAnswer, map[string]any{"call_id": callID, "sdp": answerSDP()})
	waitFor(t, callerConn, TypeCallAnswered)

	send(t, calleeConn, TypeCallHangup, map[string]any{"call_id": callID})
	var ended CallEndedPayload
	if err := DecodePayload(waitFor(t, callerConn, TypeCallEnded), &ended); err != nil {
		t.Fatalf("decode call.ended: %v", err)
	}
	if ended.Reason != "hangup" {
		t.Fatalf("reason = %q, want hangup", ended.Reason)
	}
}

func TestAClientCannotAssertAServerOnlyEndReason(t *testing.T) {
	h := newHarness(t, pairChecker(), 5)
	callerConn, calleeConn, callID := invite(t, h)
	waitFor(t, calleeConn, TypeCallIncoming)

	// A caller forging "missed" would write a history row saying the other
	// person ignored them.
	send(t, callerConn, TypeCallHangup, map[string]any{"call_id": callID, "reason": "missed"})
	expectError(t, callerConn, "bad_frame")
}

func TestUnansweredInviteBecomesAMissedCall(t *testing.T) {
	h := newHarness(t, pairChecker(), 5, func(timings *Timings) {
		timings.CallRing = 80 * time.Millisecond
	})
	callerConn, calleeConn, callID := invite(t, h)
	waitFor(t, calleeConn, TypeCallIncoming)

	var ended CallEndedPayload
	if err := DecodePayload(waitFor(t, calleeConn, TypeCallEnded), &ended); err != nil {
		t.Fatalf("decode call.ended: %v", err)
	}
	if ended.CallID != callID || ended.Reason != "missed" {
		t.Fatalf("ended = %+v, want call %s missed", ended, callID)
	}
	// Both sides stop: the caller's ringback has to end too.
	if err := DecodePayload(waitFor(t, callerConn, TypeCallEnded), &ended); err != nil {
		t.Fatalf("decode caller call.ended: %v", err)
	}
	if ended.Reason != "missed" {
		t.Fatalf("caller reason = %q, want missed", ended.Reason)
	}
}

func TestAnsweringAfterTheRingTimeoutIsRefused(t *testing.T) {
	h := newHarness(t, pairChecker(), 5, func(timings *Timings) {
		timings.CallRing = 50 * time.Millisecond
	})
	_, calleeConn, callID := invite(t, h)
	waitFor(t, calleeConn, TypeCallIncoming)
	waitFor(t, calleeConn, TypeCallEnded)

	send(t, calleeConn, TypeCallAnswer, map[string]any{"call_id": callID, "sdp": answerSDP()})
	if code := errorPayload(t, waitFor(t, calleeConn, TypeError)).Code; code != "call_gone" {
		t.Fatalf("code = %q, want call_gone", code)
	}
}

func TestFramesForAnUnknownCallAnswerCallGone(t *testing.T) {
	h := newHarness(t, pairChecker(), 5)
	conn := h.dial(t, caller)
	waitFor(t, conn, TypeReady)

	for _, frameType := range []string{TypeCallAnswer, TypeCallICE, TypeCallHangup} {
		send(t, conn, frameType, map[string]any{
			"call_id":   "no-such-call",
			"sdp":       answerSDP(),
			"candidate": candidate(),
		})
		if code := errorPayload(t, waitFor(t, conn, TypeError)).Code; code != "call_gone" {
			t.Fatalf("%s: code = %q, want call_gone", frameType, code)
		}
	}

	// And the socket survives all of it — it may be carrying another call.
	send(t, conn, TypePing, map[string]any{})
	waitFor(t, conn, TypePong)
}

// inviteWithMedia dials both sides and sends one invite, returning the caller's
// own `call.ringing` so a test can assert what the server echoed back.
func inviteWithMedia(t *testing.T, h *harness, payload map[string]any) (calleeConn *websocket.Conn, ringing CallRingingPayload) {
	t.Helper()
	callerConn := h.dial(t, caller)
	waitFor(t, callerConn, TypeReady)
	calleeConn = h.dial(t, callee)
	waitFor(t, calleeConn, TypeReady)

	send(t, callerConn, TypeCallInvite, payload)
	if err := DecodePayload(waitFor(t, callerConn, TypeCallRinging), &ringing); err != nil {
		t.Fatalf("decode call.ringing: %v", err)
	}
	return calleeConn, ringing
}

func TestVideoInviteCarriesTheMediaKindToBothSides(t *testing.T) {
	h := newHarness(t, pairChecker(), 5)
	calleeConn, ringing := inviteWithMedia(t, h, map[string]any{
		"conversation_id": "conv-1",
		"sdp":             offer(),
		"media":           calls.MediaVideo,
	})

	if ringing.Media != calls.MediaVideo {
		t.Fatalf("call.ringing media = %q, want %q", ringing.Media, calls.MediaVideo)
	}

	// The callee's ring has to know before answering: it decides whether the
	// UI says "video call" and whether the camera permission is warmed.
	var incoming CallIncomingPayload
	if err := DecodePayload(waitFor(t, calleeConn, TypeCallIncoming), &incoming); err != nil {
		t.Fatalf("decode call.incoming: %v", err)
	}
	if incoming.Media != calls.MediaVideo {
		t.Fatalf("call.incoming media = %q, want %q", incoming.Media, calls.MediaVideo)
	}
}

func TestInviteWithNoMediaKindIsAudio(t *testing.T) {
	// A client built before video existed sends no media field at all, and must
	// keep placing audio calls.
	h := newHarness(t, pairChecker(), 5)
	calleeConn, ringing := inviteWithMedia(t, h, map[string]any{
		"conversation_id": "conv-1",
		"sdp":             offer(),
	})

	if ringing.Media != calls.MediaAudio {
		t.Fatalf("call.ringing media = %q, want %q", ringing.Media, calls.MediaAudio)
	}
	var incoming CallIncomingPayload
	if err := DecodePayload(waitFor(t, calleeConn, TypeCallIncoming), &incoming); err != nil {
		t.Fatalf("decode call.incoming: %v", err)
	}
	if incoming.Media != calls.MediaAudio {
		t.Fatalf("call.incoming media = %q, want %q", incoming.Media, calls.MediaAudio)
	}
}

func TestInviteRefusesAnUnknownMediaKind(t *testing.T) {
	// Refused rather than coerced to audio: silently downgrading would ring the
	// callee with no camera and nothing explaining why.
	h := newHarness(t, pairChecker(), 5)
	callerConn := h.dial(t, caller)
	waitFor(t, callerConn, TypeReady)
	calleeConn := h.dial(t, callee)
	waitFor(t, calleeConn, TypeReady)

	send(t, callerConn, TypeCallInvite, map[string]any{
		"conversation_id": "conv-1",
		"sdp":             offer(),
		"media":           "screen",
	})

	frame := readFrame(t, callerConn)
	if frame.T != TypeError {
		t.Fatalf("next frame = %q, want %q — the invite was accepted", frame.T, TypeError)
	}
	if code := errorPayload(t, frame).Code; code != "bad_frame" {
		t.Fatalf("code = %q, want bad_frame", code)
	}
}

func TestRenegotiationIsRelayedToThePeerWithFromStamped(t *testing.T) {
	// Adding a camera to a live call is a second offer/answer exchange. The
	// server relays it like a candidate: authorize, stamp `from`, pass the SDP
	// through untouched.
	h := newHarness(t, pairChecker(), 5)
	callerConn, calleeConn, callID := invite(t, h)
	waitFor(t, calleeConn, TypeCallIncoming)
	send(t, calleeConn, TypeCallAnswer, map[string]any{"call_id": callID, "sdp": answerSDP()})
	waitFor(t, callerConn, TypeCallAnswered)

	send(t, callerConn, TypeCallRenegotiate, map[string]any{"call_id": callID, "sdp": offer()})

	var got CallRenegotiatePayload
	if err := DecodePayload(waitFor(t, calleeConn, TypeCallRenegotiate), &got); err != nil {
		t.Fatalf("decode call.renegotiate: %v", err)
	}
	if got.CallID != callID {
		t.Fatalf("call id = %q, want %q", got.CallID, callID)
	}
	// Stamped server-side, never carried up by the client.
	if got.From != caller {
		t.Fatalf("from = %q, want %q", got.From, caller)
	}

	// The SDP must arrive exactly as sent: relayed, not parsed. This service
	// never learns that a camera was added.
	want, _ := json.Marshal(offer())
	var arrived, expected map[string]any
	_ = json.Unmarshal(got.SDP, &arrived)
	_ = json.Unmarshal(want, &expected)
	if arrived["sdp"] != expected["sdp"] || arrived["type"] != expected["type"] {
		t.Fatalf("sdp = %v, want %v", arrived, expected)
	}
}

func TestRenegotiationBeforeTheCallIsAnsweredIsRefused(t *testing.T) {
	// A second exchange while the callee is still ringing would race the
	// answer's own description.
	h := newHarness(t, pairChecker(), 5)
	callerConn, calleeConn, callID := invite(t, h)
	waitFor(t, calleeConn, TypeCallIncoming)

	send(t, callerConn, TypeCallRenegotiate, map[string]any{"call_id": callID, "sdp": offer()})

	frame := readFrame(t, callerConn)
	if frame.T != TypeError {
		t.Fatalf("next frame = %q, want %q — the renegotiation was accepted", frame.T, TypeError)
	}
	if code := errorPayload(t, frame).Code; code != "bad_frame" {
		t.Fatalf("code = %q, want bad_frame", code)
	}
}

func TestRenegotiationFromSomeoneOutsideTheCallIsRefused(t *testing.T) {
	h := newHarness(t, pairChecker(), 5)
	_, calleeConn, callID := invite(t, h)
	waitFor(t, calleeConn, TypeCallIncoming)

	stranger := h.dial(t, "google_9")
	waitFor(t, stranger, TypeReady)
	send(t, stranger, TypeCallRenegotiate, map[string]any{"call_id": callID, "sdp": offer()})

	if code := errorPayload(t, waitFor(t, stranger, TypeError)).Code; code != "forbidden" {
		t.Fatalf("code = %q, want forbidden", code)
	}
}

func TestRenegotiationRelaysWhichStreamIsAScreen(t *testing.T) {
	// A peer receiving a second video track cannot tell a shared screen from a
	// camera on its own. The sender says which stream is which, and this
	// service passes it along without knowing what it means.
	h := newHarness(t, pairChecker(), 5)
	callerConn, calleeConn, callID := invite(t, h)
	waitFor(t, calleeConn, TypeCallIncoming)
	send(t, calleeConn, TypeCallAnswer, map[string]any{"call_id": callID, "sdp": answerSDP()})
	waitFor(t, callerConn, TypeCallAnswered)

	send(t, callerConn, TypeCallRenegotiate, map[string]any{
		"call_id":          callID,
		"sdp":              offer(),
		"screen_stream_id": "stream-abc",
	})

	var got CallRenegotiatePayload
	if err := DecodePayload(waitFor(t, calleeConn, TypeCallRenegotiate), &got); err != nil {
		t.Fatalf("decode call.renegotiate: %v", err)
	}
	if got.ScreenStreamID != "stream-abc" {
		t.Fatalf("screen_stream_id = %q, want %q", got.ScreenStreamID, "stream-abc")
	}
}

// TestSigningInMidRingStillRings is the regression guard for the bug dathq
// reported on 2026-09-16: calling somebody who is not signed in yet, then
// watching them sign in and see nothing at all.
//
// `call.incoming` goes out over core NATS, which delivers to whoever holds a
// subscription at that instant. A person with no socket is not a slow
// subscriber, they are no subscriber — the frame is dropped, and there is no
// history row to find later either, because that is written when somebody
// answers. So the ring existed only in Redis, which nothing read on connect.
func TestSigningInMidRingStillRings(t *testing.T) {
	h := newHarness(t, pairChecker(), 5)

	// Only the caller is connected when the call is placed.
	callerConn := h.dial(t, caller)
	waitFor(t, callerConn, TypeReady)
	send(t, callerConn, TypeCallInvite, map[string]any{
		"conversation_id": "conv-1",
		"sdp":             offer(),
	})
	var ringing CallRingingPayload
	if err := DecodePayload(waitFor(t, callerConn, TypeCallRinging), &ringing); err != nil {
		t.Fatalf("decode call.ringing: %v", err)
	}

	// The callee arrives afterwards, having missed the fan-out entirely.
	calleeConn := h.dial(t, callee)
	waitFor(t, calleeConn, TypeReady)

	var incoming CallIncomingPayload
	if err := DecodePayload(waitFor(t, calleeConn, TypeCallIncoming), &incoming); err != nil {
		t.Fatalf("decode call.incoming: %v", err)
	}
	if incoming.CallID != ringing.CallID {
		t.Fatalf("rang for call %q, want %q", incoming.CallID, ringing.CallID)
	}
	if incoming.From != caller {
		t.Fatalf("ring came from %q, want %q", incoming.From, caller)
	}
	// Deliberately no SDP: the caller's offer is stale and the candidates that
	// followed it went to the same lost subject, so the client must join and
	// let the pair negotiate fresh rather than answer this.
	if len(incoming.SDP) != 0 {
		t.Fatalf("late ring carried an SDP (%s); it must be joined, not answered", incoming.SDP)
	}
}

func TestSomebodyAlreadyInTheCallIsNotRungOnReconnect(t *testing.T) {
	// A tab that holds the call, or a second tab of the same person, must not
	// be told to start ringing for a call they are already in.
	h := newHarness(t, pairChecker(), 5)
	_, calleeConn, callID := invite(t, h)
	waitFor(t, calleeConn, TypeCallIncoming)
	send(t, calleeConn, TypeCallJoin, map[string]any{"call_id": callID})
	waitForParticipant(t, calleeConn, callee, ParticipantJoined)

	second := h.dial(t, callee)
	waitFor(t, second, TypeReady)
	expectNoFrame(t, second, TypeCallIncoming)
}
