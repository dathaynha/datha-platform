import type { Pool } from "pg";

/** Delete read notifications older than the retention window; returns rows deleted. */
export async function purgeReadNotifications(
  db: Pool,
  retentionDays: number,
): Promise<number> {
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - retentionDays);

  const result = await db.query(
    `DELETE FROM notifications WHERE read_at IS NOT NULL AND read_at < $1`,
    [cutoff],
  );
  return result.rowCount ?? 0;
}
