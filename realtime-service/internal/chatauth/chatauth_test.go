package chatauth

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

const conversationBody = `{"data":{"id":"conv-1","participants":[{"ownerId":"google_1"},{"ownerId":"google_2"}]}}`

func TestHTTPCheckerSendsOwnerHeaderAndReadsParticipants(t *testing.T) {
	var gotOwner, gotPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotOwner = r.Header.Get("X-Owner-ID")
		gotPath = r.URL.Path
		_, _ = w.Write([]byte(conversationBody))
	}))
	defer server.Close()

	checker := NewHTTPChecker(server.URL, time.Second)
	conversation, err := checker.Lookup(context.Background(), "google_1", "conv-1")
	if err != nil || conversation == nil {
		t.Fatalf("conversation = %v, err = %v; want a conversation, nil", conversation, err)
	}
	if gotOwner != "google_1" {
		t.Fatalf("X-Owner-ID = %q", gotOwner)
	}
	if gotPath != "/conversations/conv-1" {
		t.Fatalf("path = %q", gotPath)
	}
	if len(conversation.Participants) != 2 {
		t.Fatalf("participants = %v, want both", conversation.Participants)
	}
}

func TestConversationOtherExcludesSelf(t *testing.T) {
	// The callee of a call is derived from this, never from the frame — a
	// client-supplied recipient would let anyone ring anyone.
	conversation := &Conversation{
		ID:           "conv-1",
		Participants: []string{"google_1", "", "google_2"},
	}
	others := conversation.Other("google_1")
	if len(others) != 1 || others[0] != "google_2" {
		t.Fatalf("Other = %v, want [google_2]", others)
	}
}

func TestHTTPCheckerTreats404And403AsDenied(t *testing.T) {
	// messenger-service answers 404 for both "gone" and "not yours" on
	// purpose — a 403 would confirm the id exists — so both mean no.
	for _, status := range []int{http.StatusNotFound, http.StatusForbidden} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(status)
		}))
		checker := NewHTTPChecker(server.URL, time.Second)
		conversation, err := checker.Lookup(context.Background(), "google_1", "conv-1")
		if err != nil {
			t.Fatalf("status %d: unexpected error %v", status, err)
		}
		if conversation != nil {
			t.Fatalf("status %d: conversation = %v, want nil", status, conversation)
		}
		server.Close()
	}
}

func TestHTTPCheckerReportsUnexpectedStatus(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	checker := NewHTTPChecker(server.URL, time.Second)
	if _, err := checker.Lookup(context.Background(), "google_1", "conv-1"); err == nil {
		t.Fatal("a 500 must be an error, not a silent deny")
	}
}

func TestHTTPCheckerReportsUndecodableBody(t *testing.T) {
	// A 200 with no participants is not an allow: the callee could not be
	// derived, so this must fail closed rather than resolve to nobody.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("not json"))
	}))
	defer server.Close()

	checker := NewHTTPChecker(server.URL, time.Second)
	if _, err := checker.Lookup(context.Background(), "google_1", "conv-1"); err == nil {
		t.Fatal("an undecodable 200 must be an error")
	}
}

func TestHTTPCheckerFailsWithoutConfiguredURL(t *testing.T) {
	checker := NewHTTPChecker("", time.Second)
	if _, err := checker.Lookup(context.Background(), "google_1", "conv-1"); err == nil {
		t.Fatal("an unconfigured checker must not silently allow")
	}
}

type countingChecker struct {
	calls        int
	conversation *Conversation
	err          error
}

func (c *countingChecker) Lookup(context.Context, string, string) (*Conversation, error) {
	c.calls++
	return c.conversation, c.err
}

func allowedConversation() *Conversation {
	return &Conversation{ID: "conv-1", Participants: []string{"google_1", "google_2"}}
}

func TestCachingCheckerServesFromCacheWithinTTL(t *testing.T) {
	inner := &countingChecker{conversation: allowedConversation()}
	cache := NewCachingChecker(inner, time.Minute)

	for i := 0; i < 3; i++ {
		conversation, err := cache.Lookup(context.Background(), "google_1", "conv-1")
		if err != nil || conversation == nil {
			t.Fatalf("call %d: conversation = %v, err = %v", i, conversation, err)
		}
	}
	if inner.calls != 1 {
		t.Fatalf("upstream calls = %d, want 1", inner.calls)
	}
}

func TestCachingCheckerCachesDenialsToo(t *testing.T) {
	inner := &countingChecker{conversation: nil}
	cache := NewCachingChecker(inner, time.Minute)

	for i := 0; i < 2; i++ {
		if conversation, _ := cache.Lookup(context.Background(), "google_9", "conv-1"); conversation != nil {
			t.Fatal("denial must stay denied")
		}
	}
	if inner.calls != 1 {
		t.Fatalf("upstream calls = %d, want 1 — a denial loop would hammer messenger-service", inner.calls)
	}
}

func TestCachingCheckerRechecksAfterTTL(t *testing.T) {
	inner := &countingChecker{conversation: allowedConversation()}
	cache := NewCachingChecker(inner, time.Minute)
	now := time.Now()
	cache.now = func() time.Time { return now }

	_, _ = cache.Lookup(context.Background(), "google_1", "conv-1")
	now = now.Add(2 * time.Minute)
	// Membership changes; the whole point of a short TTL is that it re-asks.
	inner.conversation = nil
	if conversation, _ := cache.Lookup(context.Background(), "google_1", "conv-1"); conversation != nil {
		t.Fatal("expired entry must be re-checked, not reused")
	}
	if inner.calls != 2 {
		t.Fatalf("upstream calls = %d, want 2", inner.calls)
	}
}

func TestCachingCheckerKeysByOwnerAndConversation(t *testing.T) {
	inner := &countingChecker{conversation: allowedConversation()}
	cache := NewCachingChecker(inner, time.Minute)

	_, _ = cache.Lookup(context.Background(), "google_1", "conv-1")
	_, _ = cache.Lookup(context.Background(), "google_2", "conv-1")
	if inner.calls != 2 {
		t.Fatalf("upstream calls = %d, want 2 — one owner's allow must not cover another's", inner.calls)
	}
}

func TestCachingCheckerDoesNotCacheErrors(t *testing.T) {
	inner := &countingChecker{err: errors.New("messenger down")}
	cache := NewCachingChecker(inner, time.Minute)

	_, _ = cache.Lookup(context.Background(), "google_1", "conv-1")
	_, _ = cache.Lookup(context.Background(), "google_1", "conv-1")
	if inner.calls != 2 {
		t.Fatalf("upstream calls = %d, want 2 — a transient failure must not stick", inner.calls)
	}
}
