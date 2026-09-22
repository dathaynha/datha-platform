// Package livecheck holds the end-to-end check for the Messenger realtime path:
// a REST write to messenger-service must arrive on a live WebSocket held by
// realtime-service, having travelled through core NATS.
//
// From phase 2 it also covers the WebRTC signaling relay: an invite whose
// callee is resolved from real conversation membership, trickled ICE with a
// server-stamped sender, an answer and a hang-up.
//
// It is skipped unless RT_LIVE=1, because it needs the real stack up
// (Postgres, Redis, NATS, messenger-service :3005, realtime-service :3004).
// Run it with:
//
//	RT_LIVE=1 go test -mod=vendor ./internal/livecheck/ -count=1 -v
//
// Everything the frame protocol does in isolation is covered by
// internal/wsapi's socket tests; this is the one that proves the wiring.
package livecheck

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

type frame struct {
	T string          `json:"t"`
	D json.RawMessage `json:"d"`
}

func requireLive(t *testing.T) (socketURL, messengerURL string) {
	t.Helper()
	if os.Getenv("RT_LIVE") != "1" {
		t.Skip("set RT_LIVE=1 with the stack running to exercise the live path")
	}
	socketURL = envOr("RT_LIVE_SOCKET_URL", "ws://localhost:3004/ws")
	messengerURL = envOr("RT_LIVE_MESSENGER_URL", "http://localhost:3005")
	return socketURL, messengerURL
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

type client struct {
	t    *testing.T
	conn *websocket.Conn
}

func dial(t *testing.T, url, ownerID string) *client {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{
		HTTPHeader: http.Header{"X-Owner-ID": []string{ownerID}},
	})
	if err != nil {
		t.Fatalf("dial as %s: %v", ownerID, err)
	}
	t.Cleanup(func() { _ = conn.Close(websocket.StatusNormalClosure, "") })
	return &client{t: t, conn: conn}
}

func (c *client) send(frameType string, payload any) {
	c.t.Helper()
	body, err := json.Marshal(payload)
	if err != nil {
		c.t.Fatalf("marshal %s: %v", frameType, err)
	}
	data, err := json.Marshal(frame{T: frameType, D: body})
	if err != nil {
		c.t.Fatalf("marshal frame %s: %v", frameType, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := c.conn.Write(ctx, websocket.MessageText, data); err != nil {
		c.t.Fatalf("write %s: %v", frameType, err)
	}
}

// waitFor reads until the wanted frame type arrives. Other frames are expected
// in flight (presence, receipts), so this cannot assert on frame order.
func (c *client) waitFor(frameType string) frame {
	c.t.Helper()
	for i := 0; i < 12; i++ {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_, data, err := c.conn.Read(ctx)
		cancel()
		if err != nil {
			c.t.Fatalf("waiting for %s: %v", frameType, err)
		}
		var f frame
		if err := json.Unmarshal(data, &f); err != nil {
			c.t.Fatalf("decode %s: %v", data, err)
		}
		if f.T == frameType {
			return f
		}
	}
	c.t.Fatalf("no %q frame arrived", frameType)
	return frame{}
}

func api(t *testing.T, baseURL, method, path, ownerID, body string) map[string]any {
	t.Helper()
	req, err := http.NewRequest(method, baseURL+path, bytes.NewBufferString(body))
	if err != nil {
		t.Fatalf("build %s %s: %v", method, path, err)
	}
	req.Header.Set("X-Owner-ID", ownerID)
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	defer func() { _ = resp.Body.Close() }()

	var out map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil && resp.StatusCode != http.StatusNoContent {
		t.Fatalf("decode %s %s: %v", method, path, err)
	}
	if resp.StatusCode >= 400 {
		t.Fatalf("%s %s returned %d: %v", method, path, resp.StatusCode, out)
	}
	return out
}

// TestLiveSocketThroughGateway exercises the browser's real route: mint a
// stream token at /api/realtime/token, then upgrade at /api/realtime/ws. It
// needs a gateway-valid Bearer token, which only the gateway's own JWT_SECRET
// can produce, so it is skipped unless RT_LIVE_BEARER is supplied:
//
//	RT_LIVE=1 RT_LIVE_GATEWAY_URL=http://localhost:8081 RT_LIVE_BEARER=<jwt> \
//	  go test -mod=vendor ./internal/livecheck/ -count=1 -run Gateway -v
func TestLiveSocketThroughGateway(t *testing.T) {
	requireLive(t)
	gatewayURL := os.Getenv("RT_LIVE_GATEWAY_URL")
	bearer := os.Getenv("RT_LIVE_BEARER")
	if gatewayURL == "" || bearer == "" {
		t.Skip("set RT_LIVE_GATEWAY_URL and RT_LIVE_BEARER to exercise the gateway path")
	}

	get := func(path string, header http.Header) *http.Response {
		req, err := http.NewRequest(http.MethodGet, gatewayURL+path, nil)
		if err != nil {
			t.Fatalf("build GET %s: %v", path, err)
		}
		for key, values := range header {
			req.Header[key] = values
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("GET %s: %v", path, err)
		}
		return resp
	}

	t.Run("messenger routes are proxied and JWT-guarded", func(t *testing.T) {
		authed := get("/api/messenger/conversations", http.Header{"Authorization": {"Bearer " + bearer}})
		defer func() { _ = authed.Body.Close() }()
		if authed.StatusCode != http.StatusOK {
			t.Fatalf("authorised call status = %d, want 200", authed.StatusCode)
		}

		anonymous := get("/api/messenger/conversations", nil)
		defer func() { _ = anonymous.Body.Close() }()
		if anonymous.StatusCode != http.StatusUnauthorized {
			t.Fatalf("anonymous call status = %d, want 401", anonymous.StatusCode)
		}
	})

	streamToken := ""
	t.Run("the socket token is minted and short-lived", func(t *testing.T) {
		resp := get("/api/realtime/token", http.Header{"Authorization": {"Bearer " + bearer}})
		defer func() { _ = resp.Body.Close() }()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("status = %d, want 200", resp.StatusCode)
		}
		var minted struct {
			StreamToken string `json:"stream_token"`
			ExpiresIn   int    `json:"expires_in"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&minted); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if minted.StreamToken == "" {
			t.Fatal("no stream_token in the response")
		}
		// It rides in a query string, so it must not live anywhere near as long
		// as the SPA JWT (an hour).
		if minted.ExpiresIn <= 0 || minted.ExpiresIn > 120 {
			t.Fatalf("expires_in = %d, want 1..120", minted.ExpiresIn)
		}
		streamToken = minted.StreamToken
	})

	socketURL := "ws" + strings.TrimPrefix(gatewayURL, "http") +
		"/api/realtime/ws?stream_token=" + url.QueryEscape(streamToken)

	t.Run("an upgrade from a disallowed origin is refused", func(t *testing.T) {
		// A WebSocket upgrade gets no CORS preflight, so this check is the only
		// thing standing between the socket and any origin with a stolen token.
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, resp, err := websocket.Dial(ctx, socketURL, &websocket.DialOptions{
			HTTPHeader: http.Header{"Origin": {"https://evil.example.com"}},
		})
		if err == nil {
			t.Fatal("the upgrade succeeded; it must be refused")
		}
		if resp == nil || resp.StatusCode != http.StatusForbidden {
			t.Fatalf("response = %v, want 403", resp)
		}
	})

	t.Run("an upgrade without a token is refused", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		plain := "ws" + strings.TrimPrefix(gatewayURL, "http") + "/api/realtime/ws"
		_, resp, err := websocket.Dial(ctx, plain, nil)
		if err == nil {
			t.Fatal("the upgrade succeeded; it must be refused")
		}
		if resp == nil || resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("response = %v, want 401", resp)
		}
	})

	t.Run("identity comes from the token, not from client headers", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()

		conn, _, err := websocket.Dial(ctx, socketURL, &websocket.DialOptions{
			HTTPHeader: http.Header{
				"Origin": {os.Getenv("RT_LIVE_ORIGIN")},
				// Spoof attempt: the gateway strips this before forwarding.
				"X-Owner-ID": {"probe_attacker"},
			},
		})
		if err != nil {
			t.Fatalf("authorised upgrade failed: %v", err)
		}
		defer func() { _ = conn.Close(websocket.StatusNormalClosure, "") }()

		client := &client{t: t, conn: conn}
		var ready struct {
			OwnerID string `json:"owner_id"`
		}
		if err := json.Unmarshal(client.waitFor("ready").D, &ready); err != nil {
			t.Fatalf("ready payload: %v", err)
		}
		if ready.OwnerID == "probe_attacker" {
			t.Fatal("the gateway forwarded a client-supplied X-Owner-ID")
		}
		if ready.OwnerID == "" {
			t.Fatal("ready frame carries no owner_id")
		}
	})
}

func TestLiveMessengerRealtimePath(t *testing.T) {
	socketURL, messengerURL := requireLive(t)

	// Fresh owner ids per run: a direct conversation is idempotent on the
	// sorted pair, so reused ids would return the existing thread and publish
	// no conversation.created frame — right behaviour, wrong for a probe.
	stamp := time.Now().UnixNano()
	aliceID := fmt.Sprintf("probe_alice_%d", stamp)
	bobID := fmt.Sprintf("probe_bob_%d", stamp)
	carolID := fmt.Sprintf("probe_carol_%d", stamp)

	alice := dial(t, socketURL, aliceID)
	bob := dial(t, socketURL, bobID)
	alice.waitFor("ready")
	bob.waitFor("ready")

	t.Run("presence transitions reach a subscriber", func(t *testing.T) {
		alice.send("presence.subscribe", map[string]any{"owner_ids": []string{bobID}})
		alice.waitFor("presence")
		bob.send("presence.away", map[string]any{})

		for i := 0; i < 12; i++ {
			var entry struct {
				OwnerID string `json:"owner_id"`
				State   string `json:"state"`
			}
			if err := json.Unmarshal(alice.waitFor("presence").D, &entry); err != nil {
				t.Fatalf("presence payload: %v", err)
			}
			if entry.OwnerID == bobID && entry.State == "away" {
				return
			}
		}
		t.Fatal("bob's away transition never reached alice")
	})

	conversationID := ""
	t.Run("a REST write arrives on the socket", func(t *testing.T) {
		created := api(t, messengerURL, http.MethodPost, "/conversations", aliceID,
			fmt.Sprintf(`{"type":"direct","participant_owner_ids":[%q]}`, bobID))
		data, ok := created["data"].(map[string]any)
		if !ok {
			t.Fatalf("create response = %v", created)
		}
		conversationID, _ = data["id"].(string)
		if conversationID == "" {
			t.Fatalf("no conversation id in %v", created)
		}
		bob.waitFor("conversation.created")

		api(t, messengerURL, http.MethodPost, "/conversations/"+conversationID+"/messages", aliceID,
			`{"client_message_id":"live-1","body":"hello over the socket"}`)

		var payload struct {
			ConversationID string `json:"conversation_id"`
			Message        struct {
				Body          string `json:"body"`
				SenderOwnerID string `json:"senderOwnerId"`
			} `json:"message"`
		}
		if err := json.Unmarshal(bob.waitFor("message.new").D, &payload); err != nil {
			t.Fatalf("message.new payload: %v", err)
		}
		if payload.ConversationID != conversationID {
			t.Fatalf("conversation_id = %q", payload.ConversationID)
		}
		if payload.Message.Body != "hello over the socket" {
			t.Fatalf("body = %q", payload.Message.Body)
		}
		if payload.Message.SenderOwnerID != aliceID {
			t.Fatalf("sender = %q", payload.Message.SenderOwnerID)
		}
		bob.waitFor("unread.added")
	})

	t.Run("typing is refused until the conversation is opened", func(t *testing.T) {
		bob.send("typing.start", map[string]any{"conversation_id": conversationID})
		var errPayload struct {
			Code string `json:"code"`
		}
		if err := json.Unmarshal(bob.waitFor("error").D, &errPayload); err != nil {
			t.Fatalf("error payload: %v", err)
		}
		if errPayload.Code != "forbidden" {
			t.Fatalf("code = %q, want forbidden", errPayload.Code)
		}
	})

	t.Run("typing relays once both sides have opened", func(t *testing.T) {
		alice.send("conversation.open", map[string]any{"conversation_id": conversationID})
		bob.send("conversation.open", map[string]any{"conversation_id": conversationID})
		time.Sleep(300 * time.Millisecond)

		alice.send("typing.start", map[string]any{"conversation_id": conversationID})
		var payload struct {
			OwnerID string `json:"owner_id"`
			Until   string `json:"until"`
		}
		if err := json.Unmarshal(bob.waitFor("typing").D, &payload); err != nil {
			t.Fatalf("typing payload: %v", err)
		}
		if payload.OwnerID != aliceID {
			t.Fatalf("owner_id = %q, want the server-stamped sender", payload.OwnerID)
		}
		if payload.Until == "" {
			t.Fatal("typing frame carries no expiry")
		}
	})

	t.Run("a non-participant cannot open the conversation", func(t *testing.T) {
		carol := dial(t, socketURL, carolID)
		carol.waitFor("ready")
		carol.send("conversation.open", map[string]any{"conversation_id": conversationID})

		var errPayload struct {
			Code string `json:"code"`
		}
		if err := json.Unmarshal(carol.waitFor("error").D, &errPayload); err != nil {
			t.Fatalf("error payload: %v", err)
		}
		if errPayload.Code != "forbidden" {
			t.Fatalf("code = %q, want forbidden", errPayload.Code)
		}
	})

	t.Run("a read receipt travels back to the sender", func(t *testing.T) {
		listed := api(t, messengerURL, http.MethodGet,
			"/conversations/"+conversationID+"/messages", bobID, "")
		messages, _ := listed["data"].([]any)
		if len(messages) == 0 {
			t.Fatal("no messages listed")
		}
		newest, _ := messages[0].(map[string]any)
		messageID, _ := newest["id"].(string)

		api(t, messengerURL, http.MethodPost, "/conversations/"+conversationID+"/read", bobID,
			fmt.Sprintf(`{"message_id":%q}`, messageID))

		var receipt struct {
			OwnerID    string `json:"owner_id"`
			LastReadAt string `json:"last_read_at"`
		}
		if err := json.Unmarshal(alice.waitFor("receipt.read").D, &receipt); err != nil {
			t.Fatalf("receipt payload: %v", err)
		}
		if receipt.OwnerID != bobID {
			t.Fatalf("receipt owner = %q", receipt.OwnerID)
		}
		bob.waitFor("unread.cleared")
	})

	// The signaling relay against real membership. The unit tests stub the
	// conversation, so this is the one that proves the callee is derived from
	// what is actually in Postgres rather than from anything the caller sent.
	t.Run("a call is signalled end to end", func(t *testing.T) {
		offer := map[string]any{"type": "offer", "sdp": "v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n"}
		alice.send("call.invite", map[string]any{
			"conversation_id": conversationID,
			"sdp":             offer,
		})

		var ringing struct {
			CallID   string `json:"call_id"`
			CalleeID string `json:"callee_id"`
		}
		if err := json.Unmarshal(alice.waitFor("call.ringing").D, &ringing); err != nil {
			t.Fatalf("call.ringing payload: %v", err)
		}
		if ringing.CallID == "" {
			t.Fatal("no call id was issued")
		}
		if ringing.CalleeID != bobID {
			t.Fatalf("callee = %q, want %q resolved from conversation membership", ringing.CalleeID, bobID)
		}

		var incoming struct {
			CallID string          `json:"call_id"`
			From   string          `json:"from"`
			SDP    json.RawMessage `json:"sdp"`
		}
		if err := json.Unmarshal(bob.waitFor("call.incoming").D, &incoming); err != nil {
			t.Fatalf("call.incoming payload: %v", err)
		}
		if incoming.CallID != ringing.CallID || incoming.From != aliceID {
			t.Fatalf("incoming = %+v, want call %s from %s", incoming, ringing.CallID, aliceID)
		}
		if !strings.Contains(string(incoming.SDP), "v=0") {
			t.Fatalf("sdp arrived as %s, want it relayed verbatim", incoming.SDP)
		}

		// Trickle ICE runs before the answer, and a forged `from` must be
		// replaced with the sender the server knows.
		alice.send("call.ice", map[string]any{
			"call_id":   ringing.CallID,
			"candidate": map[string]any{"candidate": "candidate:1 1 UDP 2130706431 10.0.0.1 54321 typ host"},
			"from":      carolID,
		})
		var ice struct {
			From string `json:"from"`
		}
		if err := json.Unmarshal(bob.waitFor("call.ice").D, &ice); err != nil {
			t.Fatalf("call.ice payload: %v", err)
		}
		if ice.From != aliceID {
			t.Fatalf("from = %q, want %q — the server stamps it", ice.From, aliceID)
		}

		bob.send("call.answer", map[string]any{
			"call_id": ringing.CallID,
			"sdp":     map[string]any{"type": "answer", "sdp": "v=0\r\na=recvonly\r\n"},
		})
		var answered struct {
			CallID string `json:"call_id"`
			From   string `json:"from"`
		}
		if err := json.Unmarshal(alice.waitFor("call.answered").D, &answered); err != nil {
			t.Fatalf("call.answered payload: %v", err)
		}
		if answered.CallID != ringing.CallID || answered.From != bobID {
			t.Fatalf("answered = %+v", answered)
		}

		// The answering tab receives the answered_elsewhere fanout too, because
		// it goes to the whole owner subject to stop the callee's *other* tabs
		// ringing. A client holding the call as locally active must ignore it;
		// this probe consumes it so the hang-up below is not mistaken for it.
		var elsewhere struct {
			Reason string `json:"reason"`
		}
		if err := json.Unmarshal(bob.waitFor("call.ended").D, &elsewhere); err != nil {
			t.Fatalf("answered_elsewhere payload: %v", err)
		}
		if elsewhere.Reason != "answered_elsewhere" {
			t.Fatalf("reason = %q, want answered_elsewhere", elsewhere.Reason)
		}

		alice.send("call.hangup", map[string]any{"call_id": ringing.CallID})
		var ended struct {
			CallID string `json:"call_id"`
			Reason string `json:"reason"`
		}
		if err := json.Unmarshal(bob.waitFor("call.ended").D, &ended); err != nil {
			t.Fatalf("call.ended payload: %v", err)
		}
		if ended.CallID != ringing.CallID || ended.Reason != "hangup" {
			t.Fatalf("ended = %+v, want %s hangup", ended, ringing.CallID)
		}
	})
}

// TestLiveMissedCall covers the one call event that crosses into another
// product surface: `call.missed` becomes a bell notification, so it is worth
// proving against a real instance rather than a stub.
//
// It needs an instance started with a short ring timeout, because nobody wants
// a probe that sits for 30 seconds:
//
//	CALL_RING_TIMEOUT_SECONDS=2 PORT=3024 go run -mod=vendor ./cmd/realtime
//	RT_LIVE=1 RT_LIVE_FAST_RING_SOCKET_URL=ws://localhost:3024/ws \
//	  go test -mod=vendor ./internal/livecheck/ -count=1 -run TestLiveMissedCall -v
func TestLiveMissedCall(t *testing.T) {
	_, messengerURL := requireLive(t)
	socketURL := os.Getenv("RT_LIVE_FAST_RING_SOCKET_URL")
	if socketURL == "" {
		t.Skip("set RT_LIVE_FAST_RING_SOCKET_URL to an instance with a short CALL_RING_TIMEOUT_SECONDS")
	}

	stamp := time.Now().UnixNano()
	callerID := fmt.Sprintf("probe_ring_caller_%d", stamp)
	calleeID := fmt.Sprintf("probe_ring_callee_%d", stamp)

	caller := dial(t, socketURL, callerID)
	callee := dial(t, socketURL, calleeID)
	caller.waitFor("ready")
	callee.waitFor("ready")

	created := api(t, messengerURL, http.MethodPost, "/conversations", callerID,
		fmt.Sprintf(`{"type":"direct","participant_owner_ids":[%q]}`, calleeID))
	data, ok := created["data"].(map[string]any)
	if !ok {
		t.Fatalf("create response = %v", created)
	}
	conversationID, _ := data["id"].(string)
	if conversationID == "" {
		t.Fatalf("no conversation id in %v", created)
	}

	caller.send("call.invite", map[string]any{
		"conversation_id": conversationID,
		"sdp":             map[string]any{"type": "offer", "sdp": "v=0\\r\\n"},
	})
	callee.waitFor("call.incoming")

	// Nobody answers. Both sides must be released — the callee stops ringing
	// and the caller stops its ringback.
	for name, client := range map[string]*client{"callee": callee, "caller": caller} {
		var ended struct {
			Reason string `json:"reason"`
		}
		if err := json.Unmarshal(client.waitFor("call.ended").D, &ended); err != nil {
			t.Fatalf("%s call.ended payload: %v", name, err)
		}
		if ended.Reason != "missed" {
			t.Fatalf("%s reason = %q, want missed", name, ended.Reason)
		}
	}
}
