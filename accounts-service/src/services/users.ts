import type { Pool } from "pg";
import type { DirectoryRow, UserRow } from "../types/accounts";

export interface UserProfile {
  ownerId: string;
  email: string;
  displayName: string;
  pictureUrl: string;
}

export function rowToProfile(row: UserRow | DirectoryRow): UserProfile {
  return {
    ownerId: row.owner_id,
    email: row.email,
    displayName: row.display_name,
    pictureUrl: row.picture_url,
  };
}

/**
 * Entra often omits a name and a picture, so a usable label is derived rather
 * than left blank: email local part, else the owner id itself.
 */
export function deriveDisplayName(
  name: string,
  email: string,
  ownerId: string,
): string {
  const trimmed = name.trim();
  if (trimmed) return trimmed;
  const local = email.split("@")[0]?.trim();
  if (local) return local;
  return ownerId;
}

export interface SyncUserInput {
  ownerId: string;
  email: string;
  name: string;
  pictureUrl: string;
  workspaceId: string;
}

export interface SyncUserResult {
  profile: UserProfile;
  created: boolean;
}

/**
 * Upsert the platform user from gateway-injected identity, then make sure the
 * membership exists. Identity fields are only ever overwritten with a non-empty
 * value — a provider that stops sending a name must not blank the profile.
 */
export async function syncUser(
  db: Pool,
  input: SyncUserInput,
): Promise<SyncUserResult> {
  // Only a real provider name may overwrite a stored one; the derived fallback
  // is for the first insert only, or "Dat Ha" degrades to "dat" on the next
  // sync from a provider that sends no name.
  const providerName = input.name.trim();
  const providerPicture = input.pictureUrl.trim();
  const displayName = deriveDisplayName(input.name, input.email, input.ownerId);

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const result = await client.query<UserRow & { inserted: boolean }>(
      // $5 exists because display_name is the only column whose insert value
      // differs from its update value: insert uses the derived fallback,
      // update must use the raw provider name or the fallback overwrites a
      // real name. Every other column can read EXCLUDED.
      `INSERT INTO users (owner_id, email, display_name, picture_url)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (owner_id) DO UPDATE SET
         email        = COALESCE(NULLIF(EXCLUDED.email, ''), users.email),
         display_name = COALESCE(NULLIF($5::text, ''), users.display_name),
         picture_url  = COALESCE(NULLIF(EXCLUDED.picture_url, ''), users.picture_url),
         updated_at   = now(),
         last_seen_at = now()
       RETURNING *, (xmax = 0) AS inserted`,
      [input.ownerId, input.email, displayName, providerPicture, providerName],
    );

    const row = result.rows[0];

    await client.query(
      `INSERT INTO memberships (user_id, workspace_id)
       VALUES ($1, $2)
       ON CONFLICT (user_id, workspace_id) DO NOTHING`,
      [row.id, input.workspaceId],
    );

    await client.query("COMMIT");
    return { profile: rowToProfile(row), created: row.inserted };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function getUserByOwnerId(
  db: Pool,
  ownerId: string,
): Promise<UserProfile | null> {
  const result = await db.query<UserRow>(
    `SELECT * FROM users WHERE owner_id = $1`,
    [ownerId],
  );
  const row = result.rows[0];
  return row ? rowToProfile(row) : null;
}

/** Only users sharing a workspace with the caller are visible. */
const VISIBLE_TO_CALLER = `
  JOIN memberships m ON m.user_id = u.id
  WHERE m.workspace_id IN (
    SELECT mm.workspace_id FROM memberships mm
    JOIN users me ON me.id = mm.user_id
    WHERE me.owner_id = $1
  )
`;

export interface SearchDirectoryInput {
  ownerId: string;
  q: string;
  limit: number;
}

export async function searchDirectory(
  db: Pool,
  input: SearchDirectoryInput,
): Promise<UserProfile[]> {
  const result = await db.query<DirectoryRow>(
    `SELECT DISTINCT u.owner_id, u.email, u.display_name, u.picture_url
     FROM users u
     ${VISIBLE_TO_CALLER}
       AND u.owner_id <> $1
       AND ($2::text = '' OR u.display_name ILIKE '%' || $2 || '%' OR u.email ILIKE '%' || $2 || '%')
     ORDER BY u.display_name ASC
     LIMIT $3`,
    [input.ownerId, input.q, input.limit],
  );
  return result.rows.map(rowToProfile);
}

/** Batch hydration for participant lists — same visibility rule as search. */
export async function lookupUsers(
  db: Pool,
  ownerId: string,
  ownerIds: string[],
): Promise<UserProfile[]> {
  if (ownerIds.length === 0) return [];
  const result = await db.query<DirectoryRow>(
    `SELECT DISTINCT u.owner_id, u.email, u.display_name, u.picture_url
     FROM users u
     ${VISIBLE_TO_CALLER}
       AND u.owner_id = ANY($2::text[])`,
    [ownerId, ownerIds],
  );
  return result.rows.map(rowToProfile);
}
