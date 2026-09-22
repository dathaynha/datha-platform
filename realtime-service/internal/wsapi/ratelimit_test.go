package wsapi

import (
	"testing"
	"time"
)

// clock is a hand-driven time source, so the limiter's behaviour over time is
// asserted rather than slept through.
type clock struct{ at time.Time }

func newClock() *clock { return &clock{at: time.Unix(1700000000, 0)} }

func (c *clock) now() time.Time          { return c.at }
func (c *clock) advance(d time.Duration) { c.at = c.at.Add(d) }

func TestBucketAbsorbsAFullBurstThenRefuses(t *testing.T) {
	c := newClock()
	b := newBucket(5, 1, c.now)

	for i := 0; i < 5; i++ {
		if !b.allow() {
			t.Fatalf("token %d refused inside the burst", i+1)
		}
	}
	if b.allow() {
		t.Fatal("a sixth token was granted with no time elapsed")
	}
}

func TestBucketRefillsAtItsRate(t *testing.T) {
	c := newClock()
	b := newBucket(5, 2, c.now)
	for i := 0; i < 5; i++ {
		b.allow()
	}

	c.advance(400 * time.Millisecond) // 0.8 tokens at 2/s — not yet one
	if b.allow() {
		t.Fatal("a partial token was spendable")
	}
	c.advance(200 * time.Millisecond) // now 1.2 accrued
	if !b.allow() {
		t.Fatal("a whole accrued token was refused")
	}
}

func TestBucketDoesNotBankTokensBeyondItsBurst(t *testing.T) {
	c := newClock()
	b := newBucket(3, 10, c.now)

	// An idle connection must not accumulate an unbounded allowance and then
	// spend it all at once — that would defeat the point of the limit.
	c.advance(time.Hour)
	for i := 0; i < 3; i++ {
		if !b.allow() {
			t.Fatalf("token %d refused after a long idle", i+1)
		}
	}
	if b.allow() {
		t.Fatal("an hour of idling banked more than the burst")
	}
}

func TestStateChangingFramesDrawOnTheTighterBucket(t *testing.T) {
	c := newClock()
	limiter := newConnLimiter(c.now)

	// call.invite allocates a Redis key and a ring timer; conversation.open can
	// call messenger-service. Both are capped well below the general rate.
	for i := 0; i < stateBurst; i++ {
		if allowed, _ := limiter.allow(TypeCallInvite); !allowed {
			t.Fatalf("invite %d refused inside the state burst", i+1)
		}
	}
	allowed, refusedBy := limiter.allow(TypeCallInvite)
	if allowed {
		t.Fatal("invites past the state burst were allowed")
	}
	if refusedBy != "state" {
		t.Fatalf("refused by %q, want the state bucket", refusedBy)
	}

	// A cheap frame is unaffected — the general bucket still has plenty.
	if allowed, _ := limiter.allow(TypeCallICE); !allowed {
		t.Fatal("an ICE candidate was refused because invites were flooded")
	}
}

func TestConversationOpenSharesTheStateBucket(t *testing.T) {
	c := newClock()
	limiter := newConnLimiter(c.now)

	for i := 0; i < stateBurst; i++ {
		limiter.allow(TypeConversationOpen)
	}
	if allowed, _ := limiter.allow(TypeCallInvite); allowed {
		t.Fatal("opening conversations must draw down the same expensive budget as invites")
	}
}

func TestEveryFrameTypeIsChargedToTheGeneralBucket(t *testing.T) {
	c := newClock()
	limiter := newConnLimiter(c.now)

	// Flooding a cheap type must still exhaust the general allowance, or the
	// limit would only ever catch the expensive frames.
	for i := 0; i < framesBurst; i++ {
		if allowed, _ := limiter.allow(TypePing); !allowed {
			t.Fatalf("ping %d refused inside the general burst", i+1)
		}
	}
	allowed, refusedBy := limiter.allow(TypePing)
	if allowed {
		t.Fatal("pings past the general burst were allowed")
	}
	if refusedBy != "frames" {
		t.Fatalf("refused by %q, want the frames bucket", refusedBy)
	}
}

func TestATrickleICEBurstFitsInsideTheGeneralBurst(t *testing.T) {
	c := newClock()
	limiter := newConnLimiter(c.now)

	// The limit exists to stop abuse, not to break WebRTC: a real ICE gather
	// emits dozens of candidates in a second or two, and every one must relay.
	for i := 0; i < 40; i++ {
		if allowed, _ := limiter.allow(TypeCallICE); !allowed {
			t.Fatalf("candidate %d of a normal gather was refused", i+1)
		}
	}
}

func TestTheRefusalNoticeIsThrottled(t *testing.T) {
	c := newClock()
	limiter := newConnLimiter(c.now)

	// Answering every dropped frame would turn an inbound flood into an
	// outbound one.
	if !limiter.shouldNotice() {
		t.Fatal("the first refusal must be reported")
	}
	for i := 0; i < 100; i++ {
		if limiter.shouldNotice() {
			t.Fatal("a second notice went out inside the throttle window")
		}
	}
	c.advance(rateNoticeInterval)
	if !limiter.shouldNotice() {
		t.Fatal("a notice must be allowed again after the window")
	}
}
