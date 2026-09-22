// Package wsapi carries the socket's wire contract: frame shapes, encoding, and
// the rules about which fields a client is allowed to influence.
package wsapi

import (
	"encoding/json"
	"errors"
	"fmt"
)

// Frame is the whole protocol: {"t": type, "id": optional client id, "d": payload}.
// Small and explicit on purpose — an RPC framework would buy nothing here.
type Frame struct {
	T  string          `json:"t"`
	ID string          `json:"id,omitempty"`
	D  json.RawMessage `json:"d,omitempty"`
}

// Server → client frame types.
const (
	TypeReady    = "ready"
	TypePresence = "presence"
	TypeTyping   = "typing"
	TypeError    = "error"
	TypePong     = "pong"

	// Call frames, server → client.
	//
	// `call.ringing` answers the inviting client with the *server's* call id.
	// The id is generated here rather than accepted from the client, so two
	// clients cannot collide (or collide on purpose) on one call.
	TypeCallRinging  = "call.ringing"
	TypeCallIncoming = "call.incoming"
	TypeCallAnswered = "call.answered"
	TypeCallEnded    = "call.ended"
	// TypeCallParticipant reports one person joining or leaving a live call, to
	// everyone else invited to it. It is what makes a mesh repairable: a peer
	// hearing `joined` builds a connection to the newcomer, and one hearing
	// `left` tears that pair down without the whole call ending.
	TypeCallParticipant = "call.participant"
)

// Participant states carried by TypeCallParticipant. There is no `invited`
// state on the wire: the invited set is fixed at creation and travels with the
// ring, so the only transitions worth announcing are arrival and departure.
const (
	ParticipantJoined = "joined"
	ParticipantLeft   = "left"
)

// Client → server frame types.
const (
	TypePing              = "ping"
	TypePresenceSubscribe = "presence.subscribe"
	TypeConversationOpen  = "conversation.open"
	TypeConversationClose = "conversation.close"
	TypeTypingStart       = "typing.start"
	TypeTypingStop        = "typing.stop"
	TypeAway              = "presence.away"

	// Call frames, client → server.
	TypeCallInvite = "call.invite"
	TypeCallAnswer = "call.answer"
	TypeCallHangup = "call.hangup"
	// TypeCallJoin accepts a group call. It is the group's `call.answer` and
	// deliberately carries no SDP: a mesh has no single peer to answer, so the
	// pairwise offers happen afterwards, once both ends know the other is in.
	TypeCallJoin = "call.join"
)

// TypeCallRenegotiate travels in both directions, like TypeCallICE.
//
// One frame type carries both halves of a renegotiation, because the SDP's own
// `type` already says whether it is an offer or an answer — and this service
// does not parse SDP. Adding a camera to a live call is the case it exists for.
//
// It is NOT TypeCallAnswer: that one is answer-once and drives the
// ringing→active transition, so reusing it would restart a call that is
// already up.
const TypeCallRenegotiate = "call.renegotiate"

// TypeCallICE travels in both directions: a candidate a client trickles up, and
// the peer's candidate relayed back down with `from` stamped by the server.
const TypeCallICE = "call.ice"

// ErrUnknownType is returned for a frame this service does not handle, so the
// caller can answer with an error frame instead of dropping the connection.
var ErrUnknownType = errors.New("unknown frame type")

// Payload shapes.
type (
	// ReadyPayload is deliberately free of unread ids: the client reads those
	// from messenger-service itself (decision 2026-09-08), which keeps this
	// service stateless and a socket connectable while chat is down.
	ReadyPayload struct {
		OwnerID    string          `json:"owner_id"`
		ServerTime string          `json:"server_time"`
		Presence   []PresenceEntry `json:"presence"`
	}

	PresenceEntry struct {
		OwnerID string `json:"owner_id"`
		State   string `json:"state"`
		At      string `json:"at"`
	}

	PresenceSubscribePayload struct {
		OwnerIDs []string `json:"owner_ids"`
	}

	ConversationPayload struct {
		ConversationID string `json:"conversation_id"`
	}

	// TypingPayload is what goes out. `OwnerID` is stamped by the server — a
	// client-supplied `from` is never trusted or echoed.
	TypingPayload struct {
		ConversationID string `json:"conversation_id"`
		OwnerID        string `json:"owner_id"`
		Until          string `json:"until"`
		Stopped        bool   `json:"stopped,omitempty"`
	}

	ErrorPayload struct {
		Code    string `json:"code"`
		Message string `json:"message"`
		// Set only where the error names a call the client can act on —
		// `call_exists` carries the call to join. Omitted everywhere else, so
		// an error frame stays the same shape it has always been.
		CallID string `json:"call_id,omitempty"`
	}

	// CallInvitePayload starts a call. There is deliberately no `to` field: the
	// callee is resolved from conversation membership server-side, because a
	// client-chosen recipient would let anyone ring anyone.
	CallInvitePayload struct {
		ConversationID string `json:"conversation_id"`
		// Required for a 1:1 call, where the offer rides the ring so the callee
		// can answer in one round trip. Refused for a group call, which has no
		// single peer to offer to — sending one would mean offering the same
		// description to everybody.
		SDP json.RawMessage `json:"sdp,omitempty"`
		// Absent means audio, so a client built before video existed keeps
		// working. Anything other than audio or video is refused.
		Media string `json:"media,omitempty"`
		// Stable per browser tab and **across a reload** — `sessionStorage` is
		// the primitive that means exactly that. It is what lets a reloaded tab
		// take its own place in a call back instead of losing to its own dead
		// connection. Optional: without it a reload waits for the old socket's
		// close, which is the common ordering anyway.
		SessionID string `json:"session_id,omitempty"`
	}

	// CallAnswerPayload carries the answering SDP for an existing call.
	CallAnswerPayload struct {
		CallID    string          `json:"call_id"`
		SDP       json.RawMessage `json:"sdp"`
		SessionID string          `json:"session_id,omitempty"`
	}

	// CallICEPayload carries one trickled candidate. SDP and candidates are
	// opaque here: this service relays them and never parses them.
	CallICEPayload struct {
		CallID    string          `json:"call_id"`
		Candidate json.RawMessage `json:"candidate"`
		From      string          `json:"from,omitempty"`
		// Which participant this candidate is for. Required in a group, where
		// there is no single peer to derive; optional in a 1:1, so a client
		// written before the mesh keeps working unchanged. Validated against the
		// call's invited set either way — an unchecked target would turn the
		// relay into a way to trickle candidates at a stranger.
		To string `json:"to,omitempty"`
	}

	// CallHangupPayload ends a call. `reason` is validated against the reasons a
	// client may assert — `missed` and `answered_elsewhere` are server
	// conclusions and are refused from a frame.
	CallHangupPayload struct {
		CallID string `json:"call_id"`
		Reason string `json:"reason,omitempty"`
	}

	// CallRingingPayload confirms an invite to the caller with the server's id.
	CallRingingPayload struct {
		CallID         string `json:"call_id"`
		ConversationID string `json:"conversation_id"`
		// Empty for a group call, which has no single callee.
		CalleeID string `json:"callee_id,omitempty"`
		Media    string `json:"media"`
		// Everyone invited, the caller included, sorted. The caller needs it to
		// know how many tiles to expect before anyone has joined.
		Participants []string `json:"participants"`
	}

	// CallJoinPayload accepts a group call.
	CallJoinPayload struct {
		CallID    string `json:"call_id"`
		SessionID string `json:"session_id,omitempty"`
	}

	// CallParticipantPayload announces one arrival or departure.
	//
	// `participants` is the full joined set after the change rather than a
	// delta, so a client that missed a frame — core NATS is fire-and-forget —
	// re-syncs from the next one instead of drifting.
	CallParticipantPayload struct {
		CallID       string   `json:"call_id"`
		OwnerID      string   `json:"owner_id"`
		State        string   `json:"state"`
		Participants []string `json:"participants"`
	}

	// CallRenegotiatePayload carries a mid-call offer or answer. `from` is
	// stamped server-side on the way out, and ignored on the way in.
	CallRenegotiatePayload struct {
		CallID string          `json:"call_id"`
		SDP    json.RawMessage `json:"sdp"`
		From   string          `json:"from,omitempty"`
		// Which of the sender's media streams carries a shared screen rather
		// than a camera. Relayed opaquely, like the SDP: this service does not
		// know or care what a screen is, but the peer cannot tell a second
		// video track apart without being told.
		ScreenStreamID string `json:"screen_stream_id,omitempty"`
		// The participant this description is for; same rule as CallICEPayload.
		To string `json:"to,omitempty"`
	}

	// CallIncomingPayload rings the callee. `from` is stamped server-side.
	CallIncomingPayload struct {
		CallID         string `json:"call_id"`
		ConversationID string `json:"conversation_id"`
		From           string `json:"from"`
		// Absent for a group call: there is no offer yet, because there is no
		// single peer to have made one. A client must tolerate that and answer
		// with `call.join` rather than `call.answer`.
		SDP json.RawMessage `json:"sdp,omitempty"`
		// Everyone invited, sorted, so the ring can say who else is being
		// called before anyone picks up.
		Participants []string `json:"participants,omitempty"`
		// Lets the ring say "incoming video call" and warm the camera
		// permission before the callee accepts.
		Media string `json:"media"`
	}

	// CallAnsweredPayload delivers the answering SDP to the caller.
	CallAnsweredPayload struct {
		CallID string          `json:"call_id"`
		From   string          `json:"from"`
		SDP    json.RawMessage `json:"sdp"`
	}

	// CallEndedPayload closes a call for every tab of both participants.
	//
	// A client that holds this call as locally active must ignore
	// `answered_elsewhere`: that frame goes to the whole owner subject, so the
	// tab that *won* the answer race receives it too.
	CallEndedPayload struct {
		CallID string `json:"call_id"`
		Reason string `json:"reason"`
		From   string `json:"from,omitempty"`
	}
)

// Encode builds a frame with the payload marshalled.
func Encode(frameType string, payload any) ([]byte, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("marshal %s payload: %w", frameType, err)
	}
	return json.Marshal(Frame{T: frameType, D: body})
}

// EncodeError builds an error frame; it never fails, so callers can use it on
// the failure path without a second error to handle.
func EncodeError(code, message string) []byte {
	body, err := Encode(TypeError, ErrorPayload{Code: code, Message: message})
	if err != nil {
		// Both fields are plain strings, so this is unreachable; a hand-rolled
		// fallback keeps the signature clean for callers.
		return []byte(`{"t":"error","d":{"code":"internal","message":"encode failed"}}`)
	}
	return body
}

// EncodeErrorWithCall is EncodeError for a refusal the client can act on by
// going to a specific call.
func EncodeErrorWithCall(code, message, callID string) []byte {
	body, err := Encode(TypeError, ErrorPayload{
		Code: code, Message: message, CallID: callID,
	})
	if err != nil {
		return EncodeError(code, message)
	}
	return body
}

// Decode parses an inbound frame. Anything malformed is a client problem and
// must not take the connection down.
func Decode(data []byte) (Frame, error) {
	var f Frame
	if err := json.Unmarshal(data, &f); err != nil {
		return Frame{}, fmt.Errorf("decode frame: %w", err)
	}
	if f.T == "" {
		return Frame{}, errors.New("frame has no type")
	}
	return f, nil
}

// DecodePayload unmarshals a frame's payload into target.
func DecodePayload(f Frame, target any) error {
	if len(f.D) == 0 {
		return errors.New("frame has no payload")
	}
	if err := json.Unmarshal(f.D, target); err != nil {
		return fmt.Errorf("decode %s payload: %w", f.T, err)
	}
	return nil
}
