/** Body published to events.dlq.<sink> by domain consumers (see file-service dlq.service). */
export interface DlqMessageBody {
  original_subject: string;
  correlation_id: string | null;
  owner_id: string | null;
  payload: unknown;
  last_error: string;
  failed_at: string;
  envelope?: unknown;
}

export interface DlqRecordRow {
  id: string;
  subject: string;
  sink: string;
  jetstream_stream: string;
  jetstream_sequence: string;
  original_subject: string;
  owner_id: string | null;
  correlation_id: string | null;
  last_error: string;
  failed_at: Date;
  payload: unknown | null;
  envelope: unknown | null;
  ingested_at: Date;
  replayed_at: Date | null;
}
