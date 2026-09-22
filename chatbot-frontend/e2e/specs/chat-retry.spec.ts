import { authedTest as test, expect } from "../fixtures";
import {
  ASSISTANT_MESSAGE_ID,
  CONVERSATION_ID,
  dismissGlobalErrorDialog,
  mockChatApi,
  openStubbedThread,
  USER_MESSAGE_ID,
} from "../chat-api-mock";

/**
 * "Try again" on a failed reply: POST /conversations/{id}/retry-last re-runs the same
 * user turn — no second user message — and its stream is opened like a fresh send.
 */

const composer = (page: import("@playwright/test").Page) =>
  page.getByPlaceholder("Write a message…");

const tryAgain = (page: import("@playwright/test").Page) =>
  page.getByRole("button", { name: "Try again" });

const FAILED_STREAM = [
  { type: "claimed" },
  {
    type: "error",
    error_code: "provider_http_503",
    error_summary: "The AI service could not complete this request.",
    assistant_message_id: ASSISTANT_MESSAGE_ID,
  },
];

const RETRY_SUCCESS_STREAM = [
  { type: "claimed" },
  { type: "chunk", text: "Second time lucky." },
  {
    type: "done",
    assistant_message_id: "44444444-4444-4444-4444-444444444444",
    full_text: "Second time lucky.",
    conversation_id: CONVERSATION_ID,
    conversation_title: "E2E thread",
  },
];

const FAILED_HISTORY = [
  { id: USER_MESSAGE_ID, role: "user" as const, content: "Explain retries" },
  {
    id: ASSISTANT_MESSAGE_ID,
    role: "assistant" as const,
    content: "The AI service could not complete this request.",
    generation_error_code: "provider_http_503",
    generation_error_summary: "The AI service could not complete this request.",
  },
];

test("retries a failed generation and streams the second attempt", async ({
  page,
}) => {
  const api = await mockChatApi(page, {
    sendStreamEvents: FAILED_STREAM,
    retryStreamEvents: RETRY_SUCCESS_STREAM,
    models: [{ id: "gemini-3.6-flash", display_name: "Gemini Flash" }],
  });

  await page.goto("/chat");
  await composer(page).fill("Explain retries");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.locator(".chat-bubble--error")).toHaveCount(1);
  await tryAgain(page).click();

  await expect(page.getByText("Second time lucky.")).toBeVisible();
  // The dead bubble is gone and no second user message was sent.
  await expect(page.locator(".chat-bubble--error")).toHaveCount(0);
  expect(api.postedMessages).toHaveLength(1);
  expect(api.retryLastCalls).toHaveLength(1);
  expect(api.retryLastCalls[0]).toMatchObject({ model: "gemini-3.6-flash" });
});

test("offers Try again on a failed reply loaded from history", async ({
  page,
}) => {
  const api = await mockChatApi(page, {
    messages: FAILED_HISTORY,
    retryStreamEvents: RETRY_SUCCESS_STREAM,
  });

  await openStubbedThread(page);

  await expect(page.locator(".chat-bubble--error")).toHaveCount(1);
  await tryAgain(page).click();

  await expect(page.getByText("Second time lucky.")).toBeVisible();
  expect(api.retryLastCalls).toHaveLength(1);
  // Retry never creates a new user turn.
  expect(api.postedMessages).toHaveLength(0);
});

test("a 409 from retry-last surfaces an error and leaves the thread usable", async ({
  page,
}) => {
  const api = await mockChatApi(page, {
    messages: FAILED_HISTORY,
    retryLastStatus: 409,
  });

  await openStubbedThread(page);
  await tryAgain(page).click();

  // The reason surfaces in the global HTTP dialog, not as a second bubble — a bubble
  // appended after the restored one would hide its "Try again".
  await expect(page.locator("datha-message-dialog")).toContainText(
    "a generation is already running",
  );
  await dismissGlobalErrorDialog(page);

  expect(api.retryLastCalls).toHaveLength(1);
  await expect(composer(page)).toBeEnabled();
  // 409 deletes nothing server-side, so the failed reply — and its button — come back.
  await expect(
    page.getByText("The AI service could not complete this request."),
  ).toBeVisible();
  await expect(tryAgain(page)).toBeVisible();
  await expect(page.locator(".chat-bubble--error")).toHaveCount(1);
});

test("a client-side error bubble does not offer Try again", async ({
  page,
}) => {
  // The request never reached generation, so retry-last would re-run an unrelated turn.
  await mockChatApi(page, { postMessageStatus: 503 });

  await page.goto("/chat");
  await composer(page).fill("Backend down");
  await page.getByRole("button", { name: "Send" }).click();

  await dismissGlobalErrorDialog(page);
  await expect(page.locator(".chat-bubble--error")).toHaveCount(1);
  await expect(tryAgain(page)).toHaveCount(0);
});

/**
 * Worker-side retry (layer 1). These need the stream to stay OPEN after the
 * `retrying` frame, so they run against the local SSE server (`liveSse`) rather
 * than a fulfilled route — fulfilling closes the body, which EventSource reports
 * as an error and would race the assertion.
 */

test("shows retry progress while the stream stays open, then streams the reply", async ({
  page,
}) => {
  const api = await mockChatApi(page, {
    liveSse: {
      "*": [
        { data: { type: "claimed" } },
        {
          delayMs: 100,
          data: { type: "retrying", attempt: 2, max_attempts: 3 },
        },
        {
          delayMs: 2500,
          data: { type: "chunk", text: "Second attempt worked." },
        },
        {
          delayMs: 100,
          data: {
            type: "done",
            assistant_message_id: ASSISTANT_MESSAGE_ID,
            full_text: "Second attempt worked.",
            conversation_id: CONVERSATION_ID,
            conversation_title: "E2E thread",
          },
        },
      ],
    },
  });

  await page.goto("/chat");
  await composer(page).fill("Provider is flaky");
  await page.getByRole("button", { name: "Send" }).click();

  // Job is alive, not frozen: the pending bubble reports the attempt.
  await expect(page.getByText(/retrying \(2\/3\)/)).toBeVisible();
  await expect(page.locator(".chat-bubble--typing")).toBeVisible();

  // The retry frame must not end the stream — the reply still arrives.
  await expect(page.getByText("Second attempt worked.")).toBeVisible();
  await expect(page.getByText(/retrying/)).toBeHidden();
  await expect(page.locator(".chat-bubble--error")).toHaveCount(0);

  await api.stopSse();
});

test("exhausted retries end in an error bubble offering Try again", async ({
  page,
}) => {
  const api = await mockChatApi(page, {
    liveSse: {
      "*": [
        { data: { type: "claimed" } },
        {
          delayMs: 50,
          data: { type: "retrying", attempt: 2, max_attempts: 3 },
        },
        {
          delayMs: 50,
          data: { type: "retrying", attempt: 3, max_attempts: 3 },
        },
        {
          delayMs: 50,
          data: {
            type: "error",
            error_code: "provider_http_503",
            error_summary: "The AI service could not complete this request.",
            assistant_message_id: ASSISTANT_MESSAGE_ID,
          },
        },
      ],
    },
  });

  await page.goto("/chat");
  await composer(page).fill("Provider is down");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.locator(".chat-bubble--error")).toHaveCount(1);
  await expect(tryAgain(page)).toBeVisible();
  await expect(page.locator(".chat-bubble--typing")).toBeHidden();

  await api.stopSse();
});
