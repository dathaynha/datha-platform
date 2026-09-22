-- A call may end without anyone being able to say so.
--
-- `ended_at` is written only by the projection of a `call.ended` event, and
-- that event is published by realtime-service — the very process that may be
-- what died. An instance killed or rolled mid-call took the only closer of its
-- calls with it: the Redis record expired in silence, no event was ever
-- published, and this row kept `ended_at NULL` **forever**, so the thread went
-- on offering to join a call that had not existed for days (dathq, 2026-09-15:
-- "the data is wrong when there's a bug happen").
--
-- realtime-service now reaps calls whose instance is gone, which closes the
-- common case properly. This is the backstop for the case where the *event*
-- never arrives at all — NATS down, the consumer stopped, the message in the
-- DLQ — and it needs nobody's cooperation to run.
--
-- `expired` is its own reason rather than being folded into `hangup`, because
-- the two are different facts: somebody pressed a button, or nobody ever told
-- us. Only one of them should be counted as a completed call.
ALTER TABLE calls DROP CONSTRAINT IF EXISTS calls_end_reason_check;

ALTER TABLE calls
  ADD CONSTRAINT calls_end_reason_check
  CHECK (end_reason IN ('hangup', 'declined', 'missed', 'busy', 'ice_failed', 'expired'));

-- The sweep reads this: unfinished calls, oldest first.
CREATE INDEX IF NOT EXISTS calls_unfinished_idx
  ON calls (started_at)
  WHERE ended_at IS NULL;
