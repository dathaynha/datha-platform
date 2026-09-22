/** GET /conversations — matches FastAPI `ConversationSummaryOut` JSON. */
export interface ConversationSummaryDto {
  readonly id: string;
  readonly created_at: string;
  /** AI-assigned after first reply; user can PATCH (server). */
  readonly title?: string;
  readonly message_count: number;
  readonly last_message_at: string | null;
}

/** Nested file metadata on `MessageOut`. */
export interface HistoryMessageFileDto {
  readonly file_id: string;
  readonly name: string;
  readonly mime_type?: string | null;
}

/** GET /conversations/{id}/messages — matches FastAPI `MessageOut` JSON. */
export interface HistoryMessageDto {
  readonly id: string;
  readonly conversation_id: string;
  readonly role: string;
  readonly content: string;
  readonly generation_error_code?: string | null;
  readonly generation_error_summary?: string | null;
  readonly generation_error_detail?: string | null;
  readonly created_at: string;
  readonly files?: readonly HistoryMessageFileDto[];
}

/** GET `/conversations/{id}/messages` — paginated payload (`MessagesPageOut`). */
export interface HistoryMessagesPageDto {
  readonly messages: readonly HistoryMessageDto[];
  readonly has_more: boolean;
}

/** PATCH /conversations/{id} — response body. */
export interface ConversationTitleDto {
  readonly id: string;
  readonly title: string;
}
