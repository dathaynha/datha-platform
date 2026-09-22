CREATE TABLE IF NOT EXISTS messages (
  id                 UUID PRIMARY KEY,
  conversation_id    UUID NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  sender_owner_id    TEXT NOT NULL,
  kind               TEXT NOT NULL DEFAULT 'text'
                       CHECK (kind IN ('text', 'attachment', 'system')),
  body               TEXT NOT NULL DEFAULT '',
  -- file-service id only; bytes never live in this database.
  attachment_file_id TEXT,
  -- Caller-generated idempotency key: a retried send returns the original row
  -- instead of duplicating the message.
  client_message_id  TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  edited_at          TIMESTAMPTZ,
  deleted_at         TIMESTAMPTZ,
  UNIQUE (conversation_id, sender_owner_id, client_message_id)
);

CREATE INDEX IF NOT EXISTS messages_conversation_created_idx
  ON messages (conversation_id, created_at DESC);
