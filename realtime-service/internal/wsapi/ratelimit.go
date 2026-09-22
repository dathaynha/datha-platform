package wsapi

import (
	"sync"
	"time"
)

// Rate limits, per connection.
//
// Two buckets rather than one, because the frames have very different costs.
// `call.ice` is legitimately bursty — trickle ICE can emit thirty candidates in
// a couple of seconds — so a single bucket wide enough for ICE would be far too
// generous for the frames that allocate.
const (
	// framesBurst / framesRefill bound raw flooding of any frame type. Sized
	// off an ICE burst plus normal typing traffic, with room to spare.
	framesBurst  = 120
	framesRefill = 40 // per second

	// stateBurst / stateRefill bound the two frames that cost more than a
	// publish: `call.invite` creates a Redis key plus a ring timer, and
	// `conversation.open` can make an upstream call to messenger-service.
	stateBurst  = 5
	stateRefill = 0.5 // per second

	// rateNoticeInterval throttles the refusal frame itself. A client is told
	// once per second that it is being limited; answering every dropped frame
	// would turn an inbound flood into an outbound one.
	rateNoticeInterval = time.Second
)

// isStateChangingFrame reports whether a frame allocates server-side state or
// makes an upstream request, and so draws on the tighter bucket.
func isStateChangingFrame(frameType string) bool {
	// call.join allocates too: it claims a member field and flips a call active.
	return frameType == TypeCallInvite ||
		frameType == TypeCallJoin ||
		frameType == TypeConversationOpen
}

// bucket is a token bucket. Tokens accrue at `refill` per second up to `burst`,
// so a burst is absorbed and a sustained flood is not.
type bucket struct {
	mu     sync.Mutex
	tokens float64
	burst  float64
	refill float64
	last   time.Time
	now    func() time.Time
}

func newBucket(burst, refill float64, now func() time.Time) *bucket {
	return &bucket{
		tokens: burst,
		burst:  burst,
		refill: refill,
		last:   now(),
		now:    now,
	}
}

// allow takes one token, reporting whether there was one to take.
func (b *bucket) allow() bool {
	b.mu.Lock()
	defer b.mu.Unlock()

	now := b.now()
	if elapsed := now.Sub(b.last).Seconds(); elapsed > 0 {
		b.tokens = min(b.burst, b.tokens+elapsed*b.refill)
		b.last = now
	}
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// connLimiter is one connection's pair of buckets plus the notice throttle.
type connLimiter struct {
	frames *bucket
	state  *bucket

	mu         sync.Mutex
	lastNotice time.Time
	now        func() time.Time
}

func newConnLimiter(now func() time.Time) *connLimiter {
	return &connLimiter{
		frames: newBucket(framesBurst, framesRefill, now),
		state:  newBucket(stateBurst, stateRefill, now),
		now:    now,
	}
}

// allow reports whether this frame may be handled, and which bucket refused it.
//
// Every frame is charged to the general bucket first, so flooding one of the
// expensive types drains that bucket too rather than hiding behind its own.
func (l *connLimiter) allow(frameType string) (bool, string) {
	if !l.frames.allow() {
		return false, "frames"
	}
	if isStateChangingFrame(frameType) && !l.state.allow() {
		return false, "state"
	}
	return true, ""
}

// shouldNotice reports whether the client should be told it is being limited.
// At most one refusal frame per second, however many frames are dropped.
func (l *connLimiter) shouldNotice() bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := l.now()
	if !l.lastNotice.IsZero() && now.Sub(l.lastNotice) < rateNoticeInterval {
		return false
	}
	l.lastNotice = now
	return true
}
