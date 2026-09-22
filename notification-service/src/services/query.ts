import type { Pool } from "pg";
import type { NotificationRow } from "../types/notifications";

export interface NotificationListParams {
  ownerId: string;
  unread?: boolean;
  limit: number;
  /** Cursor: return rows created strictly before this instant (from the previous page's last row). */
  before?: Date;
}

export type NotificationDto = ReturnType<typeof rowToNotification>;

export function rowToNotification(row: NotificationRow) {
  return {
    id: row.id,
    type: row.type,
    severity: row.severity,
    sourceService: row.source_service,
    titleKey: row.title_key,
    bodyKey: row.body_key,
    params: row.params,
    link: row.link,
    correlationId: row.correlation_id,
    readAt: row.read_at ? row.read_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
  };
}

export async function listNotifications(
  db: Pool,
  params: NotificationListParams,
) {
  const conditions = ["owner_id = $1"];
  const values: unknown[] = [params.ownerId];
  let idx = 2;

  if (params.unread) {
    conditions.push("read_at IS NULL");
  }
  if (params.before) {
    conditions.push(`created_at < $${idx++}`);
    values.push(params.before);
  }

  const result = await db.query<NotificationRow>(
    `SELECT id, owner_id, type, severity, source_service, title_key, body_key, params, link, correlation_id, read_at, created_at
     FROM notifications
     WHERE ${conditions.join(" AND ")}
     ORDER BY created_at DESC
     LIMIT $${idx}`,
    [...values, params.limit],
  );
  return result.rows.map(rowToNotification);
}

export async function unreadCount(db: Pool, ownerId: string): Promise<number> {
  const result = await db.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM notifications WHERE owner_id = $1 AND read_at IS NULL`,
    [ownerId],
  );
  return parseInt(result.rows[0]?.count ?? "0", 10);
}

/** Returns false when the notification does not exist or belongs to another owner. */
export async function setReadState(
  db: Pool,
  ownerId: string,
  id: string,
  read: boolean,
): Promise<boolean> {
  const result = await db.query(
    read
      ? `UPDATE notifications SET read_at = now()
         WHERE id = $1 AND owner_id = $2 AND read_at IS NULL`
      : `UPDATE notifications SET read_at = NULL
         WHERE id = $1 AND owner_id = $2 AND read_at IS NOT NULL`,
    [id, ownerId],
  );
  if ((result.rowCount ?? 0) > 0) {
    return true;
  }
  const exists = await db.query(
    `SELECT 1 FROM notifications WHERE id = $1 AND owner_id = $2`,
    [id, ownerId],
  );
  return (exists.rowCount ?? 0) > 0;
}

export async function markAllRead(db: Pool, ownerId: string): Promise<number> {
  const result = await db.query(
    `UPDATE notifications SET read_at = now()
     WHERE owner_id = $1 AND read_at IS NULL`,
    [ownerId],
  );
  return result.rowCount ?? 0;
}
