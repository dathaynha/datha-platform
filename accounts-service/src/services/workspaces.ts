import type { Pool } from "pg";
import type { WorkspaceRow } from "../types/accounts";

/** Idempotent: the shared workspace is created once and reused by every sync. */
export async function ensureWorkspace(
  db: Pool,
  slug: string,
  name: string,
): Promise<WorkspaceRow> {
  const result = await db.query<WorkspaceRow>(
    `INSERT INTO workspaces (slug, name)
     VALUES ($1, $2)
     ON CONFLICT (slug) DO UPDATE SET name = workspaces.name
     RETURNING id, slug, name, created_at`,
    [slug, name],
  );
  return result.rows[0];
}

export interface WorkspaceSummary {
  id: string;
  slug: string;
  name: string;
  role: string;
}

export async function listWorkspacesForOwner(
  db: Pool,
  ownerId: string,
): Promise<WorkspaceSummary[]> {
  const result = await db.query<{
    id: string;
    slug: string;
    name: string;
    role: string;
  }>(
    `SELECT w.id, w.slug, w.name, m.role
     FROM workspaces w
     JOIN memberships m ON m.workspace_id = w.id
     JOIN users u ON u.id = m.user_id
     WHERE u.owner_id = $1
     ORDER BY w.name ASC`,
    [ownerId],
  );
  return result.rows;
}
