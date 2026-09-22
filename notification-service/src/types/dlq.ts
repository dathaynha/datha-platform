/** Body published to events.dlq.<sink> by domain consumers (same shape as event-store). */
export interface DlqMessageBody {
  original_subject: string;
  correlation_id: string | null;
  owner_id: string | null;
  payload: unknown;
  last_error: string;
  failed_at: string;
  envelope?: unknown;
}
