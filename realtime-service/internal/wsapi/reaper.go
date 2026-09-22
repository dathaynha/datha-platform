package wsapi

import (
	"context"
	"log/slog"
	"time"

	"datha-platform/realtime-service/internal/calls"
)

/*
Closing calls that no process is holding any more.

`releaseCalls` ends a call when a socket drops, and it walks the connections
this process tracks **in its own memory** — which is exactly the wrong place for
the case where the process itself is what died. An instance killed, crashed or
rolled during a deploy takes the only closer of its calls with it: the Redis
record expires silently an hour later, expiry publishes nothing, `call.ended` is
never emitted, and `messenger-service`'s projection keeps `ended_at NULL`
forever. The thread then offers to join a call that has not existed since
Tuesday.

That is the shape dathq named on 2026-09-15 — "the data is wrong when there's a
bug happen" — and the fix is not to make crashes rarer. It is to make the
closing of a call reachable by somebody other than the process that started it.
*/

// ReapOrphanedCalls ends every call whose members all belong to dead instances.
//
// Safe to run on any instance, and safe to run concurrently on several: ending
// a call consumes its record atomically, so exactly one reaper announces it.
func (s *Server) ReapOrphanedCalls(ctx context.Context) {
	orphans, err := s.calls.FindOrphans(ctx)
	if err != nil {
		slog.Warn("orphan sweep failed", "error", err)
		return
	}
	for _, orphan := range orphans {
		slog.Info("ending a call no instance is holding",
			"call", orphan.Call.ID,
			"conversation", orphan.Call.ConversationID,
			"stranded", orphan.Stranded,
			"status", orphan.Call.Status)
		// `hangup` rather than a reason of its own: what a stranded participant
		// experienced is a call that stopped, and inventing an `orphaned`
		// end-reason would mean a migration in messenger-service for a
		// distinction nobody reading their own call history wants drawn. The
		// log carries the operational truth.
		s.endCall(ctx, orphan.Call, calls.ReasonHangup, "")
		// Counted rather than only logged: a steady zero is the healthy state,
		// and a rising line says instances are dying mid-call — which is the
		// thing to alert on, since the calls themselves are already cleaned up.
		s.metrics.CallsReaped.Inc()
	}
}

// StartReaper sweeps once at boot and then on a slow ticker, until ctx is done.
//
// The sweep at boot is the one that matters: the commonest orphan by far is a
// call this very service was holding before it was restarted. The ticker covers
// an instance that dies while others keep running.
func (s *Server) StartReaper(ctx context.Context, interval time.Duration) {
	s.ReapOrphanedCalls(ctx)
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				s.ReapOrphanedCalls(ctx)
			}
		}
	}()
}
