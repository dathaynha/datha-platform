import { expect, type Page } from "@playwright/test";
import { startSseServer, type SseFrame } from "./sse-server";

/**
 * Route-mocked chatbot gateway (`/api/chatbot/v1/*`) and file-service
 * (`/api/files/*`) so specs need no backend.
 *
 * API-hitting specs are deliberately out of scope until a staging environment
 * exists — see `testing/e2e-testing-strategy.md`.
 */

export const CONVERSATION_ID = "11111111-1111-1111-1111-111111111111";
export const JOB_ID = "22222222-2222-2222-2222-222222222222";
/** Job id returned by retry-last, so its stream can serve different frames. */
export const RETRY_JOB_ID = "33333333-3333-3333-3333-333333333333";
export const USER_MESSAGE_ID = "33333333-3333-3333-3333-333333333333";
export const ASSISTANT_MESSAGE_ID = "44444444-4444-4444-4444-444444444444";
export const FILE_ID = "55555555-5555-5555-5555-555555555555";

const GATEWAY = "**/api/chatbot/v1";
const FILES = "**/api/files";
export const SAS_HOST = "https://e2e-blob.local";

export interface MessageStub {
  id: string;
  role: "user" | "assistant";
  content: string;
  files?: { file_id: string; name: string; mime_type?: string }[];
  generation_error_code?: string;
  generation_error_summary?: string;
}

export interface ConversationStub {
  id: string;
  title?: string;
  message_count?: number;
}

export interface ActiveJobStub {
  job_id: string;
  user_message_id: string;
  status: "pending" | "processing";
  stream_token: string;
}

export interface ChatApiStubs {
  conversations?: ConversationStub[];
  /** Extra pages returned by later GET /conversations calls (sidebar pagination). */
  conversationPages?: ConversationStub[][];
  conversationsStatus?: number;
  messages?: MessageStub[];
  messagesHasMore?: boolean;
  messagesStatus?: number;
  /** Rows served for the `before_id` (older page) request. */
  olderMessages?: MessageStub[];
  olderMessagesStatus?: number;
  activeJob?: ActiveJobStub | null;
  streamEvents?: Record<string, unknown>[];
  /** SSE frames for the stream opened by a fresh POST /messages. */
  sendStreamEvents?: Record<string, unknown>[];
  /** SSE frames for the stream opened after POST /conversations/{id}/retry-last. */
  retryStreamEvents?: Record<string, unknown>[];
  /**
   * Frames served by a real local SSE server instead of a fulfilled route, keyed by
   * job id (`"*"` matches any). Use when a spec must observe an OPEN stream — e.g.
   * the worker's `retrying` frame — because fulfilling closes the body, which
   * EventSource reports as an error. Frames carry their own `delayMs`.
   */
  liveSse?: Record<string, SseFrame[]>;
  retryLastStatus?: number;
  /**
   * Keep the job looking in-flight: serves a `claimed` frame from the local SSE
   * server and leaves the socket open. Shorthand for `liveSse` with no reply.
   */
  holdStreamOpen?: boolean;
  postMessageStatus?: number;
  patchTitleStatus?: number;
  deleteStatus?: number;
  models?: { id: string; display_name: string }[];
  modelsStatus?: number;
  prepareStatus?: number;
  confirmStatus?: number;
  blobPutStatus?: number;
}

export const DEFAULT_CONVERSATION: ConversationStub = {
  id: CONVERSATION_ID,
  title: "E2E thread",
  message_count: 2,
};

function conversationRow(c: ConversationStub, index: number) {
  return {
    id: c.id,
    created_at: "2026-01-01T00:00:00.000Z",
    title: c.title,
    message_count: c.message_count ?? 0,
    last_message_at: new Date(Date.UTC(2026, 0, 2, 0, index)).toISOString(),
  };
}

function historyRow(row: MessageStub, index: number) {
  return {
    id: row.id,
    conversation_id: CONVERSATION_ID,
    role: row.role,
    content: row.content,
    generation_error_code: row.generation_error_code ?? null,
    generation_error_summary: row.generation_error_summary ?? null,
    generation_error_detail: null,
    created_at: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    files: row.files ?? [],
  };
}

function sseBody(events: Record<string, unknown>[]): string {
  const frames = events
    .map((ev, i) => `id: ${i + 1}\ndata: ${JSON.stringify(ev)}\n\n`)
    .join("");
  return `retry: 60000\n\n${frames}`;
}

/** Requests captured for assertions (POST bodies, older-page cursors). */
export interface ChatApiRecorder {
  postedMessages: Record<string, unknown>[];
  olderPageCursors: string[];
  streamUrls: string[];
  patchedTitles: Record<string, unknown>[];
  deletedConversations: string[];
  deletedFiles: string[];
  /** Bodies posted to /conversations/{id}/retry-last. */
  retryLastCalls: Record<string, unknown>[];
  /** Stops the local SSE server when `liveSse` was used (no-op otherwise). */
  stopSse: () => Promise<void>;
  /**
   * Any `/api/**` call no stub claimed. Without this tripwire such calls reach the
   * real gateway on :8080, which 401s the e2e-minted JWT and pops the global error
   * dialog — a confusing failure far from its cause.
   */
  unexpectedRequests: string[];
}

export async function mockChatApi(
  page: Page,
  stubs: ChatApiStubs = {},
): Promise<ChatApiRecorder> {
  const {
    conversations = [DEFAULT_CONVERSATION],
    conversationPages = [],
    conversationsStatus = 200,
    messages = [],
    messagesHasMore = false,
    messagesStatus = 200,
    olderMessages = [],
    olderMessagesStatus = 200,
    activeJob = null,
    streamEvents = [],
    sendStreamEvents,
    retryStreamEvents,
    retryLastStatus = 200,
    liveSse,
    postMessageStatus = 200,
    patchTitleStatus = 200,
    deleteStatus = 204,
    models = [{ id: "gemini-flash-latest", display_name: "Gemini Flash" }],
    modelsStatus = 200,
    holdStreamOpen = false,
    prepareStatus = 200,
    confirmStatus = 200,
    blobPutStatus = 201,
  } = stubs;

  const recorder: ChatApiRecorder = {
    postedMessages: [],
    olderPageCursors: [],
    streamUrls: [],
    patchedTitles: [],
    deletedConversations: [],
    deletedFiles: [],
    retryLastCalls: [],
    stopSse: async () => {},
    unexpectedRequests: [],
  };

  // Registered first so every specific stub below takes precedence; whatever is
  // left is a gap in the stubs, not traffic for a real backend.
  await page.route("**/api/**", (route) => {
    recorder.unexpectedRequests.push(
      `${route.request().method()} ${route.request().url()}`,
    );
    return route.fulfill({
      status: 599,
      json: { detail: "unmocked request — add a stub in chat-api-mock.ts" },
    });
  });

  // Later registrations win, so generic routes go first and the specific
  // /messages, /active-job, /stream routes override them.
  await page.route(`${GATEWAY}/conversations**`, (route) => {
    const method = route.request().method();
    const url = route.request().url();

    if (method === "DELETE") {
      const id = url.split("/conversations/")[1]?.split(/[?/]/)[0] ?? "";
      recorder.deletedConversations.push(id);
      return deleteStatus >= 400
        ? route.fulfill({ status: deleteStatus, json: { detail: "nope" } })
        : route.fulfill({ status: deleteStatus, body: "" });
    }

    if (method === "PATCH") {
      recorder.patchedTitles.push(route.request().postDataJSON());
      if (patchTitleStatus >= 400) {
        return route.fulfill({
          status: patchTitleStatus,
          json: { detail: "nope" },
        });
      }
      const id = url.split("/conversations/")[1]?.split(/[?/]/)[0] ?? "";
      return route.fulfill({
        json: { id, title: route.request().postDataJSON()["title"] },
      });
    }

    if (conversationsStatus >= 400) {
      return route.fulfill({
        status: conversationsStatus,
        json: { detail: "nope" },
      });
    }

    // Keyed on `offset`, not call order: the sidebar also auto-fetches when scrolled
    // near the bottom, so call-order stubbing served the wrong page under load.
    const offset = Number(new URL(url).searchParams.get("offset") ?? "0");
    const rows =
      offset === 0
        ? conversations
        : (conversationPages[
            Math.max(0, Math.ceil(offset / conversations.length) - 1)
          ] ?? []);
    return route.fulfill({ json: rows.map(conversationRow) });
  });

  await page.route(`${GATEWAY}/models**`, (route) =>
    modelsStatus >= 400
      ? route.fulfill({ status: modelsStatus, json: { detail: "nope" } })
      : route.fulfill({
          json: {
            models,
            default_model: models[0]?.id ?? "gemini-flash-latest",
          },
        }),
  );

  await page.route(`${GATEWAY}/conversations/*/messages**`, (route) => {
    const url = new URL(route.request().url());
    const beforeId = url.searchParams.get("before_id");

    if (beforeId) {
      recorder.olderPageCursors.push(beforeId);
      return olderMessagesStatus >= 400
        ? route.fulfill({
            status: olderMessagesStatus,
            json: { detail: "nope" },
          })
        : route.fulfill({
            json: { messages: olderMessages.map(historyRow), has_more: false },
          });
    }

    return messagesStatus >= 400
      ? route.fulfill({ status: messagesStatus, json: { detail: "nope" } })
      : route.fulfill({
          json: {
            messages: messages.map(historyRow),
            has_more: messagesHasMore,
          },
        });
  });

  await page.route(`${GATEWAY}/conversations/*/retry-last**`, (route) => {
    recorder.retryLastCalls.push(route.request().postDataJSON());
    if (retryLastStatus >= 400) {
      return route.fulfill({
        status: retryLastStatus,
        json: {
          detail: "a generation is already running for this conversation",
        },
      });
    }
    return route.fulfill({
      json: {
        job_id: RETRY_JOB_ID,
        correlation_id: RETRY_JOB_ID,
        conversation_id: CONVERSATION_ID,
        user_message_id: USER_MESSAGE_ID,
        stream_token: "e2e-retry-token",
      },
    });
  });

  await page.route(`${GATEWAY}/conversations/*/active-job**`, (route) =>
    activeJob
      ? route.fulfill({ json: activeJob })
      : route.fulfill({ status: 204, body: "" }),
  );

  await page.route(`${GATEWAY}/messages**`, (route) => {
    recorder.postedMessages.push(route.request().postDataJSON());
    if (postMessageStatus >= 400) {
      return route.fulfill({
        status: postMessageStatus,
        json: { detail: "nope" },
      });
    }
    return route.fulfill({
      json: {
        job_id: JOB_ID,
        correlation_id: "e2e-correlation",
        conversation_id: CONVERSATION_ID,
        user_message_id: USER_MESSAGE_ID,
        stream_token: "e2e-stream-token",
      },
    });
  });

  // One-shot: the reconnect after completion gets a 404 so EventSource stops
  // retrying and specs stay deterministic.
  const sseScripts =
    liveSse ??
    (holdStreamOpen ? { "*": [{ data: { type: "claimed" } }] } : null);

  if (sseScripts) {
    const sse = await startSseServer(sseScripts);
    recorder.stopSse = sse.close;
    // Page close is the reliable teardown hook here; specs may also call stopSse().
    page.once("close", () => void sse.close());

    await page.route(`${GATEWAY}/stream/**`, (route) => {
      const requested = new URL(route.request().url());
      recorder.streamUrls.push(requested.href);
      const jobId = requested.pathname.split("/").filter(Boolean).pop() ?? "";
      // Rewritten rather than fulfilled: only a real socket can stay open.
      return route.continue({
        url: `${sse.url}/stream/${encodeURIComponent(jobId)}${requested.search}`,
      });
    });
  }

  let streamServed = false;
  if (!sseScripts)
    await page.route(`${GATEWAY}/stream/**`, async (route) => {
      recorder.streamUrls.push(route.request().url());
      if (retryStreamEvents && route.request().url().includes(RETRY_JOB_ID)) {
        return route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          body: sseBody(retryStreamEvents),
        });
      }
      if (streamServed) {
        return route.fulfill({
          status: 404,
          json: { detail: "job not found" },
        });
      }
      streamServed = true;
      return route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: sseBody(sendStreamEvents ?? streamEvents),
      });
    });

  // ── file-service (attachments) ─────────────────────────────────────────
  await page.route(`${FILES}/prepare**`, (route) =>
    prepareStatus >= 400
      ? route.fulfill({ status: prepareStatus, json: { detail: "nope" } })
      : route.fulfill({
          json: { fileId: FILE_ID, sasUploadUrl: `${SAS_HOST}/upload?sig=e2e` },
        }),
  );

  await page.route(`${FILES}/*/confirm**`, (route) =>
    confirmStatus >= 400
      ? route.fulfill({ status: confirmStatus, json: { detail: "nope" } })
      : route.fulfill({
          json: {
            id: FILE_ID,
            name: "note.txt",
            mimeType: "text/plain",
            sizeBytes: 12,
            status: "uploaded",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        }),
  );

  await page.route(`${FILES}/*/download-url**`, (route) =>
    route.fulfill({
      json: {
        sasDownloadUrl: `${SAS_HOST}/download?sig=e2e`,
        expiresAt: "2030-01-01T00:00:00.000Z",
      },
    }),
  );

  // Removing a pending attachment deletes the uploaded blob.
  await page.route(`${FILES}/*`, (route) => {
    if (route.request().method() !== "DELETE") {
      return route.fallback();
    }
    const id =
      route.request().url().split("/files/")[1]?.split(/[?/]/)[0] ?? "";
    recorder.deletedFiles.push(id);
    return route.fulfill({ status: 204, body: "" });
  });

  // Blob PUT goes straight to Azure (no Bearer) — intercept the SAS host.
  await page.route(`${SAS_HOST}/**`, (route) =>
    route.fulfill({ status: blobPutStatus, body: "" }),
  );

  return recorder;
}

/** Opens the chat page and selects the stubbed conversation from the sidebar. */
export async function openStubbedThread(
  page: Page,
  title = "E2E thread",
): Promise<void> {
  await page.goto("/chat");
  await page.getByRole("button", { name: title }).click();
}

/**
 * Waits until the thread has settled at the bottom.
 *
 * Opening a thread starts a "follow bottom" phase that keeps clamping scroll while
 * layout shifts (previews, error rows). Scrolling up before it settles is racy — the
 * clamp wins and the scroll is undone.
 */
export async function settleAtBottom(page: Page): Promise<void> {
  const thread = page.locator(".chat-thread");
  await expect
    .poll(
      () =>
        thread.evaluate(
          (el) => el.scrollHeight - el.scrollTop - el.clientHeight <= 2,
        ),
      { timeout: 10_000 },
    )
    .toBe(true);
}

/**
 * Dismisses the app's global HTTP-error dialog, which fronts any failed request
 * and blocks the page until closed.
 */
export async function dismissGlobalErrorDialog(page: Page): Promise<void> {
  const dialog = page.locator("datha-message-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "OK" }).click();
  await expect(dialog).toHaveCount(0);
}

/**
 * Scrolls the thread to the top until `until` resolves true.
 *
 * A single `scrollTo({ top: 0 })` can land before the thread is tall enough to
 * scroll (history still painting), so the older-page fetch never triggers.
 */
export async function scrollToTopUntil(
  page: Page,
  until: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const thread = page.locator(".chat-thread");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await thread.evaluate((el) => el.scrollTo({ top: 0 }));
    if (await until()) {
      return;
    }
    await page.waitForTimeout(100);
  }
  throw new Error("scrollToTopUntil: condition never became true");
}
