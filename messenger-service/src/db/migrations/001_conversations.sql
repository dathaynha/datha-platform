CREATE TABLE IF NOT EXISTS conversations (
  id              UUID PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  type            TEXT NOT NULL CHECK (type IN ('direct', 'group')),
  -- Sorted 'ownerA|ownerB' for direct conversations, NULL for groups. The unique
  -- index is what makes POST /conversations idempotent: two people opening each
  -- other at the same moment must land in one thread, not two.
  direct_key      TEXT UNIQUE,
  title           TEXT,
  created_by      TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_message_at TIMESTAMPTZ,
  deleted_at      TIMESTAMPTZ,
  CONSTRAINT conversations_direct_key_shape CHECK (
    (type = 'direct' AND direct_key IS NOT NULL) OR
    (type = 'group' AND direct_key IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS conversations_last_message_at_idx
  ON conversations (last_message_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS conversations_tenant_id_idx ON conversations (tenant_id);

CREATE TABLE IF NOT EXISTS conversation_participants (
  conversation_id UUID NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  owner_id        TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin')),
  joined_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  left_at         TIMESTAMPTZ,
  -- The read watermark. One column answers both "is this unread for me" and
  -- "how far has the other side read", and it cannot drift the way per-message
  -- receipt rows can.
  last_read_at    TIMESTAMPTZ,
  muted_until     TIMESTAMPTZ,
  PRIMARY KEY (conversation_id, owner_id)
);

CREATE INDEX IF NOT EXISTS conversation_participants_owner_active_idx
  ON conversation_participants (owner_id)
  WHERE left_at IS NULL;
