-- A call is activity, and the list did not think so.
--
-- `last_message_at` was both the preview's timestamp and the list's sort key,
-- and it is written in exactly one place: the message transaction. So a call —
-- placed, missed, declined, or an hour long — moved a conversation nowhere
-- (dathq, 2026-09-16). Bumping `last_message_at` from the call projection
-- would have fixed the symptom by making the column's name a lie, and the next
-- kind of activity would have had to lie with it.
--
-- So the sort key becomes its own column. `last_message_at` goes back to
-- meaning what it says (the preview's own timestamp), and `last_activity_at`
-- means "when something last happened here", which is the question the list
-- actually asks.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ;

-- Backfill from both sources. A conversation that has never had either falls
-- back to its creation, which is what the old ORDER BY's second key did.
UPDATE conversations c
   SET last_activity_at = GREATEST(
         COALESCE(c.last_message_at, c.created_at),
         COALESCE(
           (SELECT max(GREATEST(k.started_at, COALESCE(k.ended_at, k.started_at)))
              FROM calls k
             WHERE k.conversation_id = c.id),
           c.created_at))
 WHERE c.last_activity_at IS NULL;

-- NOT NULL is what makes the keyset cursor total. The old cursor compared a
-- nullable column, so `WHERE last_message_at < $cursor` could not page past a
-- conversation that had never been used -- the walk simply ended early at the
-- first empty thread. A sort key with no null has no such tail.
ALTER TABLE conversations ALTER COLUMN last_activity_at SET DEFAULT now();
ALTER TABLE conversations ALTER COLUMN last_activity_at SET NOT NULL;

-- (last_activity_at, id) matches the ORDER BY and the cursor's tuple compare,
-- so the page walk is one index scan and ties break deterministically. Two
-- conversations sharing a timestamp used to be able to straddle a page
-- boundary and drop a row.
CREATE INDEX IF NOT EXISTS conversations_last_activity_idx
  ON conversations (last_activity_at DESC, id DESC);

-- Nothing orders by `last_message_at` any more; the column stays, its index
-- does not. An unused index is write cost on every message.
DROP INDEX IF EXISTS conversations_last_message_at_idx;
