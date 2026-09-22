/** Fallback when GET /models fails; should match chatbot-service `CHAT_DEFAULT_MODEL`. */
export const DEFAULT_CHAT_MODEL_ID = "gemini-3.6-flash";

/**
 * Picker options when GET /models fails — mirrors the service `_STATIC_CHAT_MODELS`.
 * Explicit pins, not `-latest` aliases: the alias is what 503d under load.
 */
export const FALLBACK_CHAT_MODELS = [
  { id: DEFAULT_CHAT_MODEL_ID, display_name: "Gemini 3.6 Flash" },
  { id: "gemini-3.5-flash-lite", display_name: "Gemini 3.5 Flash Lite" },
] as const;

/** Matches chatbot-service `MessageCreate.files` max length. */
export const MAX_CHAT_ATTACHMENTS = 10;

/** Max single attachment — aligned with file-service `MAX_UPLOAD_BYTES` / worker fetch cap. */
export const MAX_CHAT_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** Parallel prepare → blob PUT → confirm jobs; avoids saturating browser connections. */
export const UPLOAD_CONCURRENCY = 4;

/** Initial page size for GET `/conversations/{id}/messages` (matches backend default). */
export const THREAD_MESSAGE_PAGE_SIZE = 40;

/** URL query param carrying the open conversation, so a reload keeps the thread. */
export const CONVERSATION_QUERY_PARAM = "c";

/** When scrollTop falls below this, fetch older messages (infinite scroll). */
export const THREAD_LOAD_OLDER_SCROLL_TOP_PX = 140;

/**
 * While “follow bottom” is active after opening a thread, releasing when the viewport
 * is farther than this many pixels from the bottom (user scrolled up to read).
 *
 * A nudge, not a gesture. At 120px this was larger than the 48px at which the
 * old bottom-sentinel observer re-asserted the pin, so a drag landing between
 * the two was pulled back to the bottom and the thread read as stuck
 * (2026-09-21). The observer is gone; this stays small because during a live
 * stream the resize pin is still running, and scrolling back to read should
 * win the first time it is asked rather than the third.
 */
export const THREAD_PIN_BOTTOM_RELEASE_GAP_PX = 24;

/**
 * Show the jump-to-latest button once the viewport sits this far above the bottom.
 * Deliberately larger than `THREAD_PIN_BOTTOM_RELEASE_GAP_PX`: releasing follow-bottom
 * happens as soon as the user nudges up, but the button should only appear once they
 * have actually scrolled away.
 */
export const THREAD_JUMP_TO_BOTTOM_GAP_PX = 240;

/** Page size for GET `/conversations` in the chat sidebar (backend allows up to 100). */
export const SIDEBAR_CONVERSATIONS_PAGE_SIZE = 50;

/** When sidebar scroll is within this distance of the bottom, fetch the next page. */
export const SIDEBAR_LOAD_MORE_NEAR_BOTTOM_PX = 80;
