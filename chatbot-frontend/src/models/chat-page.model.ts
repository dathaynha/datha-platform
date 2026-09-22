/** Shown on user bubbles (pending upload or from history). */
export interface ChatBubbleAttachment {
  readonly file_id?: string;
  readonly name: string;
  readonly mime_type?: string | null;
}

/** Composer-only row: stable order, upload state, optional local preview URL. */
export interface ComposerAttachmentRow {
  readonly client_key: string;
  file_id: string | null;
  name: string;
  mime_type: string | null;
  /** Image: blob URL (revoke on remove). PDF thumb: data URL. */
  preview_url: string | null;
  uploading: boolean;
  failed?: boolean;
}

export interface ChatBubble {
  /** Stable id: server message UUID when loaded from history, or client UUID while sending. */
  readonly id: string;
  readonly role: "user" | "assistant" | "error";
  readonly text: string;
  /**
   * Error bubble from a failed generation, so the thread can offer "Try again".
   * Client-side errors (attachment rejected, request never sent) leave this unset —
   * `retry-last` would re-run an unrelated turn.
   */
  readonly retryable?: boolean;
  readonly attachments?: readonly ChatBubbleAttachment[];
}
