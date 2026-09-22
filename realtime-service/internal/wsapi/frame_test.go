package wsapi

import (
	"encoding/json"
	"testing"
)

func TestEncodeProducesTheWireShape(t *testing.T) {
	data, err := Encode(TypeTyping, TypingPayload{
		ConversationID: "conv-1",
		OwnerID:        "google_1",
		Until:          "2026-09-08T10:00:00Z",
	})
	if err != nil {
		t.Fatalf("Encode: %v", err)
	}

	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if raw["t"] != TypeTyping {
		t.Fatalf(`frame type = %v, want %q`, raw["t"], TypeTyping)
	}
	payload, ok := raw["d"].(map[string]any)
	if !ok {
		t.Fatalf("payload is %T, want object", raw["d"])
	}
	if payload["owner_id"] != "google_1" {
		t.Fatalf("owner_id = %v, want google_1", payload["owner_id"])
	}
}

func TestReadyCarriesNoUnreadIDs(t *testing.T) {
	// The client fetches unread from messenger-service itself (decision
	// 2026-09-08), so this service stays stateless and a socket can become
	// ready while chat is down. Guard the shape so it cannot drift back.
	data, err := Encode(TypeReady, ReadyPayload{OwnerID: "google_1", ServerTime: "now"})
	if err != nil {
		t.Fatalf("Encode: %v", err)
	}
	var raw struct {
		D map[string]json.RawMessage `json:"d"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	for _, forbidden := range []string{"unread_conversation_ids", "unread"} {
		if _, present := raw.D[forbidden]; present {
			t.Fatalf("ready frame must not carry %q", forbidden)
		}
	}
}

func TestDecodeRejectsMalformedAndTypelessFrames(t *testing.T) {
	if _, err := Decode([]byte("not json")); err == nil {
		t.Fatal("malformed frame should not decode")
	}
	if _, err := Decode([]byte(`{"d":{}}`)); err == nil {
		t.Fatal("a frame with no type should not decode")
	}
}

func TestDecodeKeepsPayloadRaw(t *testing.T) {
	frame, err := Decode([]byte(`{"t":"conversation.open","d":{"conversation_id":"conv-1"}}`))
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	var payload ConversationPayload
	if err := DecodePayload(frame, &payload); err != nil {
		t.Fatalf("DecodePayload: %v", err)
	}
	if payload.ConversationID != "conv-1" {
		t.Fatalf("conversation_id = %q", payload.ConversationID)
	}
}

func TestDecodePayloadFailsWithNoPayload(t *testing.T) {
	frame, err := Decode([]byte(`{"t":"conversation.open"}`))
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	var payload ConversationPayload
	if err := DecodePayload(frame, &payload); err == nil {
		t.Fatal("a payload-less frame should fail to decode into a payload")
	}
}

func TestEncodeErrorAlwaysProducesAFrame(t *testing.T) {
	frame, err := Decode(EncodeError("forbidden", "nope"))
	if err != nil {
		t.Fatalf("error frame did not decode: %v", err)
	}
	if frame.T != TypeError {
		t.Fatalf("type = %q, want %q", frame.T, TypeError)
	}
}
