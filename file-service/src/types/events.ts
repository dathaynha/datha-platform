/** Standard platform event envelope (platform/event-store-architecture.md). */
export interface PlatformEvent {
  id: string;
  type: string;
  service: string;
  entity_id: string;
  owner_id: string;
  correlation_id: string | null;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface ConversationDeletedPayload {
  conversation_id: string;
  file_ids: string[];
}

export interface DlqRecord {
  original_subject: string;
  correlation_id: string | null;
  owner_id: string | null;
  payload: unknown;
  last_error: string;
  failed_at: string;
  envelope?: unknown;
}
