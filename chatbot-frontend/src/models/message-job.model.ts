/** One attachment reference for `POST /messages` (`files` array; snake_case JSON). */
export interface MessageFileAttachPayload {
  file_id: string;
  name: string;
  mime_type?: string | null;
}

/** POST /messages body (matches FastAPI `MessageCreate`). */
export interface MessageCreate {
  text: string;
  conversation_id?: string | null;
  model?: string;
  files?: readonly MessageFileAttachPayload[];
}

/** POST /messages response (UUIDs as strings from JSON). */
export interface MessageJobResponse {
  job_id: string;
  correlation_id: string;
  conversation_id: string;
  user_message_id: string;
  /** Short-lived token injected by the api-gateway. Pass as ?stream_token= on the SSE URL. */
  stream_token: string;
}

/**
 * GET /conversations/{id}/active-job response — a generation still running for
 * this thread, so a revisit can re-open its stream. 204 maps to `null`.
 */
export interface ActiveJobDto {
  job_id: string;
  user_message_id: string;
  /** pending = queued, processing = worker claimed it. */
  status: "pending" | "processing";
  /** Short-lived token injected by the api-gateway, same as POST /messages. */
  stream_token: string;
}

export interface MessageStreamChunkEvent {
  readonly type: "chunk";
  readonly text: string;
}

export interface MessageStreamDoneEvent {
  readonly type: "done";
  readonly assistant_message_id: string;
  readonly full_text: string;
  /** Present when the worker finished naming the thread (may be empty). */
  readonly conversation_id?: string;
  readonly conversation_title?: string;
}

/** Worker acknowledgment — emitted when the job is picked up, before any chunk. */
export interface MessageStreamClaimedEvent {
  readonly type: "claimed";
}

/**
 * Emitted when the worker hit a retryable provider error before any chunk and is
 * waiting to try again — the job is still alive.
 */
export interface MessageStreamRetryingEvent {
  readonly type: "retrying";
  /** 1-based number of the attempt about to run. */
  readonly attempt: number;
  readonly max_attempts: number;
}

export interface MessageStreamErrorEvent {
  readonly type: "error";
  readonly detail?: string;
  readonly body?: string;
  readonly error_code?: string;
  readonly error_summary?: string;
  readonly error_detail?: string;
  readonly assistant_message_id?: string;
}

export type MessageStreamEvent =
  | MessageStreamChunkEvent
  | MessageStreamClaimedEvent
  | MessageStreamDoneEvent
  | MessageStreamErrorEvent
  | MessageStreamRetryingEvent;
