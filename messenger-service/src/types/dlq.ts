/**
 * Body published to `events.dlq.<sink>` when a projection gives up.
 *
 * Same shape as event-store's ingest expects and as notification-service
 * publishes — each service carries its own copy because there is no shared
 * backend package in this workspace.
 */
export interface DlqMessageBody {
  original_subject: string;
  correlation_id: string | null;
  owner_id: string | null;
  payload: unknown;
  last_error: string;
  failed_at: string;
  envelope?: unknown;
}
