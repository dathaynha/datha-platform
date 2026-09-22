-- Call history: a read model projected from realtime-service's call events.
-- The events are the record; this table is derived, so it is rebuildable by
-- replaying the EVENTS stream.
--
-- Rows are upserted by call id and every column fills monotonically, because
-- the projection must survive both a JetStream redelivery and an `ended` that
-- overtakes its `started` (a nak requeues one message while the loop moves on).
CREATE TABLE IF NOT EXISTS calls (
  id               UUID PRIMARY KEY,
  conversation_id  UUID NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  caller_owner_id  TEXT NOT NULL,
  callee_owner_id  TEXT NOT NULL,
  started_at       TIMESTAMPTZ NOT NULL,
  -- NULL means never answered: a missed or declined call.
  answered_at      TIMESTAMPTZ,
  ended_at         TIMESTAMPTZ,
  end_reason       TEXT
                     CHECK (end_reason IN ('hangup', 'declined', 'missed', 'busy', 'ice_failed')),
  duration_seconds INTEGER NOT NULL DEFAULT 0 CHECK (duration_seconds >= 0)
);

-- A conversation's calls, newest first.
CREATE INDEX IF NOT EXISTS calls_conversation_started_idx
  ON calls (conversation_id, started_at DESC);

-- "My calls" reads both roles, so each gets its own index rather than one
-- scan per role over an unordered table.
CREATE INDEX IF NOT EXISTS calls_caller_started_idx
  ON calls (caller_owner_id, started_at DESC);
CREATE INDEX IF NOT EXISTS calls_callee_started_idx
  ON calls (callee_owner_id, started_at DESC);
