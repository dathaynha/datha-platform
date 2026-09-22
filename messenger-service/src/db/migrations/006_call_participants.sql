-- Group calls: who was on a call, projected from realtime-service's events.
--
-- The `calls` table was shaped for a pair — caller and callee — which a group
-- call has no answer for. Rather than overload those two columns, membership
-- moves to its own table and `callee_owner_id` becomes nullable: a 1:1 call
-- still fills it, a group call leaves it NULL and is described by its
-- participants.
ALTER TABLE calls
  ALTER COLUMN callee_owner_id DROP NOT NULL;

-- One row per person who was *invited* to the call — everyone it rang.
--
-- `joined` separates being rung from being on the call, which is the whole
-- point: "who missed it" is exactly the set with joined = false, and a person
-- who joined and dropped out early still counts as having been on it.
--
-- Like every other column in this projection it fills monotonically: joined
-- goes false -> true and never back, so a JetStream redelivery or an `ended`
-- overtaking its `started` converges on the same rows.
CREATE TABLE IF NOT EXISTS call_participants (
  call_id  UUID NOT NULL REFERENCES calls (id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  joined   BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (call_id, owner_id)
);

-- "My calls" for a group participant, who is neither the caller nor the callee.
CREATE INDEX IF NOT EXISTS call_participants_owner_idx
  ON call_participants (owner_id);
