// Package chatauth answers two questions for the socket: may this owner open
// this conversation, and who else is in it? Both answers come from
// messenger-service, which owns membership — this service holds no domain
// state.
package chatauth

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"
)

// Conversation is the slice of a conversation this service needs.
//
// Participants exist here for one reason: a call invite must resolve the callee
// server-side. Trusting a client-supplied `to` would let anyone ring anyone,
// which is the same rule that stamps `from` on every relayed frame.
type Conversation struct {
	ID           string
	Participants []string
}

// Other returns the participants that are not ownerID.
func (c *Conversation) Other(ownerID string) []string {
	others := make([]string, 0, len(c.Participants))
	for _, participant := range c.Participants {
		if participant != ownerID && participant != "" {
			others = append(others, participant)
		}
	}
	return others
}

// Checker resolves conversation membership.
type Checker interface {
	// Lookup returns the conversation when the owner is a participant, and nil
	// when they are not. A nil conversation with a nil error is a *denial*, not
	// an absence of information.
	Lookup(ctx context.Context, ownerID, conversationID string) (*Conversation, error)
}

// HTTPChecker calls messenger-service. It asks once per opened conversation,
// not per keystroke: authorization happens when a client subscribes to a
// conversation's ephemeral subject, and publishing afterwards is allowed
// because the subscription was authorized.
type HTTPChecker struct {
	baseURL string
	client  *http.Client
}

// NewHTTPChecker builds a checker against messenger-service's base URL.
func NewHTTPChecker(baseURL string, timeout time.Duration) *HTTPChecker {
	return &HTTPChecker{
		baseURL: baseURL,
		client:  &http.Client{Timeout: timeout},
	}
}

// conversationResponse is the shape of GET /conversations/:id.
type conversationResponse struct {
	Data struct {
		ID           string `json:"id"`
		Participants []struct {
			OwnerID string `json:"ownerId"`
		} `json:"participants"`
	} `json:"data"`
}

// Lookup fetches the conversation. messenger-service answers 404 for both
// "gone" and "not yours" by design, so both mean no.
func (c *HTTPChecker) Lookup(ctx context.Context, ownerID, conversationID string) (*Conversation, error) {
	if c.baseURL == "" {
		return nil, fmt.Errorf("messenger-service url is not configured")
	}
	url := fmt.Sprintf("%s/conversations/%s", c.baseURL, conversationID)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("build membership request: %w", err)
	}
	// Same trust model as every other internal call: the owner id is a header,
	// and this hop is service-to-service on a private network.
	req.Header.Set("X-Owner-ID", ownerID)

	resp, err := c.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("membership request: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	switch resp.StatusCode {
	case http.StatusOK:
	case http.StatusNotFound, http.StatusForbidden:
		return nil, nil
	default:
		return nil, fmt.Errorf("membership check returned %d", resp.StatusCode)
	}

	var body conversationResponse
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return nil, fmt.Errorf("decode conversation %s: %w", conversationID, err)
	}
	conversation := &Conversation{
		ID:           body.Data.ID,
		Participants: make([]string, 0, len(body.Data.Participants)),
	}
	if conversation.ID == "" {
		conversation.ID = conversationID
	}
	for _, participant := range body.Data.Participants {
		conversation.Participants = append(conversation.Participants, participant.OwnerID)
	}
	return conversation, nil
}

// CachingChecker memoises positive and negative answers for a short window, so
// reopening threads does not hammer messenger-service. The TTL is deliberately
// short: membership can change, and a stale allow on a *typing indicator* is a
// tolerable failure — a stale allow on message content would not be, which is
// why message delivery is routed per owner rather than per conversation.
//
// Starting a call runs through this same cache: within one TTL window a
// just-removed member could still ring someone. That is bounded by the TTL and
// still cannot deliver media, because the callee has to answer.
type CachingChecker struct {
	inner Checker
	ttl   time.Duration
	now   func() time.Time

	mu      sync.Mutex
	entries map[string]cacheEntry
}

type cacheEntry struct {
	conversation *Conversation
	expiresAt    time.Time
}

// NewCachingChecker wraps a checker with a TTL cache.
func NewCachingChecker(inner Checker, ttl time.Duration) *CachingChecker {
	return &CachingChecker{
		inner:   inner,
		ttl:     ttl,
		now:     time.Now,
		entries: map[string]cacheEntry{},
	}
}

// Lookup answers from cache when fresh, otherwise delegates and stores. Both
// the allow and the deny are cached, so a denial loop cannot hammer
// messenger-service either.
func (c *CachingChecker) Lookup(ctx context.Context, ownerID, conversationID string) (*Conversation, error) {
	key := ownerID + "|" + conversationID

	c.mu.Lock()
	entry, ok := c.entries[key]
	fresh := ok && c.now().Before(entry.expiresAt)
	c.mu.Unlock()
	if fresh {
		return entry.conversation, nil
	}

	conversation, err := c.inner.Lookup(ctx, ownerID, conversationID)
	if err != nil {
		return nil, err
	}

	c.mu.Lock()
	c.entries[key] = cacheEntry{conversation: conversation, expiresAt: c.now().Add(c.ttl)}
	c.mu.Unlock()
	return conversation, nil
}
