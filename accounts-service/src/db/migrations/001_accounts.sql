-- Platform identity: workspaces, users linked to gateway owner_id, memberships.
-- owner_id is the gateway's prefixed identity (google_<sub> / entra_<oid>) and is
-- the only join key other services know about.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS workspaces (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      TEXT UNIQUE NOT NULL,
  email         TEXT NOT NULL DEFAULT '',
  display_name  TEXT NOT NULL DEFAULT '',
  picture_url   TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memberships (
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role          TEXT NOT NULL DEFAULT 'member',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, workspace_id)
);

CREATE INDEX IF NOT EXISTS memberships_workspace_idx ON memberships (workspace_id);
CREATE INDEX IF NOT EXISTS users_email_idx ON users (lower(email));
CREATE INDEX IF NOT EXISTS users_display_name_idx ON users (lower(display_name));
