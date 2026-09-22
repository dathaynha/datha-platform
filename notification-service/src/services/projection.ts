import type { Pool } from "pg";
import type {
  NotificationRow,
  NotificationSeverity,
} from "../types/notifications";
import { rowToNotification, type NotificationDto } from "./query";

export interface NotificationInsert {
  sourceKey: string;
  ownerId: string;
  type: string;
  severity: NotificationSeverity;
  sourceService: string;
  titleKey: string;
  bodyKey: string;
  params: Record<string, unknown>;
  link?: string | null;
  correlationId: string | null;
}

/**
 * Idempotent — duplicate JetStream delivery of the same source is a no-op.
 * Returns the inserted notification (API shape, for SSE fanout), or null on conflict.
 */
export async function insertNotification(
  db: Pool,
  notification: NotificationInsert,
): Promise<NotificationDto | null> {
  const result = await db.query<NotificationRow>(
    `INSERT INTO notifications (source_key, owner_id, type, severity, source_service, title_key, body_key, params, link, correlation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
     ON CONFLICT (source_key) DO NOTHING
     RETURNING id, owner_id, type, severity, source_service, title_key, body_key, params, link, correlation_id, read_at, created_at`,
    [
      notification.sourceKey,
      notification.ownerId,
      notification.type,
      notification.severity,
      notification.sourceService,
      notification.titleKey,
      notification.bodyKey,
      JSON.stringify(notification.params),
      notification.link ?? null,
      notification.correlationId,
    ],
  );
  const row = result.rows[0];
  return row ? rowToNotification(row) : null;
}
