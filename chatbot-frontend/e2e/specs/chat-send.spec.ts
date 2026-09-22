import { authedTest as test, expect } from "../fixtures";
import {
  ASSISTANT_MESSAGE_ID,
  CONVERSATION_ID,
  mockChatApi,
} from "../chat-api-mock";

/** Composer → POST /messages → SSE stream: the core send/stream loop. */

const composer = (page: import("@playwright/test").Page) =>
  page.getByPlaceholder("Write a message…");

const DONE_EVENT = {
  type: "done",
  assistant_message_id: ASSISTANT_MESSAGE_ID,
  full_text: "Hello from the model.",
  conversation_id: CONVERSATION_ID,
  conversation_title: "E2E thread",
};

test("sends a message and streams the reply", async ({ page }) => {
  const api = await mockChatApi(page, {
    sendStreamEvents: [
      { type: "claimed" },
      { type: "chunk", text: "Hello from " },
      { type: "chunk", text: "the model." },
      DONE_EVENT,
    ],
  });

  await page.goto("/chat");
  await composer(page).fill("Hi there");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.getByText("Hi there")).toBeVisible();
  await expect(page.getByText("Hello from the model.")).toBeVisible();
  await expect(page.locator(".chat-bubble--typing")).toBeHidden();

  expect(api.postedMessages).toHaveLength(1);
  expect(api.postedMessages[0]).toMatchObject({ text: "Hi there" });
});

test("Enter sends, Shift+Enter inserts a newline", async ({ page }) => {
  const api = await mockChatApi(page, { sendStreamEvents: [DONE_EVENT] });

  await page.goto("/chat");
  const box = composer(page);

  await box.fill("first line");
  await box.press("Shift+Enter");
  await box.pressSequentially("second line");
  expect(await box.inputValue()).toContain("\n");
  expect(api.postedMessages).toHaveLength(0);

  await box.press("Enter");
  await expect.poll(() => api.postedMessages.length).toBe(1);
  expect(api.postedMessages[0]["text"]).toContain("second line");
});

test("shows the queued indicator until the worker claims the job", async ({
  page,
}) => {
  // The stream is never answered, so the job stays "in flight" as it would mid-generation.
  await mockChatApi(page, { holdStreamOpen: true });

  await page.goto("/chat");
  await composer(page).fill("Slow one");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.locator(".chat-bubble--typing")).toBeVisible();
  await expect(page.getByText("Queued")).toBeVisible();
});

test("a stream error event renders an error bubble", async ({ page }) => {
  await mockChatApi(page, {
    sendStreamEvents: [
      {
        type: "error",
        error_code: "GENERATION_FAILED",
        error_summary: "The model refused this request.",
        assistant_message_id: ASSISTANT_MESSAGE_ID,
      },
    ],
  });

  await page.goto("/chat");
  await composer(page).fill("Trigger failure");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.getByText("The model refused this request.")).toBeVisible();
  await expect(page.locator(".chat-bubble--error")).toHaveCount(1);
  await expect(page.locator(".chat-bubble--typing")).toBeHidden();
});

test("a failed POST /messages surfaces an error bubble", async ({ page }) => {
  await mockChatApi(page, { postMessageStatus: 503 });

  await page.goto("/chat");
  await composer(page).fill("Backend down");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.locator(".chat-bubble--error")).toHaveCount(1);
  await expect(page.locator(".chat-bubble--typing")).toBeHidden();
});

test("the send button only exists for a non-empty draft, and the composer clears", async ({
  page,
}) => {
  const api = await mockChatApi(page, { sendStreamEvents: [DONE_EVENT] });

  await page.goto("/chat");
  const send = page.getByRole("button", { name: "Send" });

  // Nothing to send: the button is not rendered at all.
  await expect(send).toHaveCount(0);

  // Whitespace does not count as a draft either.
  await composer(page).fill("   ");
  await expect(send).toHaveCount(0);

  await composer(page).fill("Real message");
  await expect(send).toBeVisible();
  await send.click();

  await expect.poll(() => api.postedMessages.length).toBe(1);
  await expect(composer(page)).toHaveValue("");
});
