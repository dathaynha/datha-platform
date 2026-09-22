import { authedTest as test, expect } from "../fixtures";
import {
  CONVERSATION_ID,
  DEFAULT_CONVERSATION,
  mockChatApi,
} from "../chat-api-mock";

/**
 * The open conversation lives in the URL.
 *
 * Reported 2026-09-21: picking a chat and reloading dropped you back on a
 * blank new chat, because the open thread was a signal and nothing else. It is
 * now the `c` query param, which also makes a thread linkable and makes the
 * back button move between threads.
 *
 * A query param rather than `/chat/:id`: Angular reuses a component only when
 * the route config is the same object, so sibling `chat` and `chat/:id` routes
 * would destroy this page on every switch — and it owns the SSE stream, the
 * conversation list and the attachment set rather than delegating them to a
 * store. See the comment in `ngOnInit`.
 */

const SECOND_ID = "66666666-6666-6666-6666-666666666666";

const twoThreads = (page: import("@playwright/test").Page) =>
  mockChatApi(page, {
    conversations: [
      DEFAULT_CONVERSATION,
      { id: SECOND_ID, title: "Second thread" },
    ],
    messages: [{ id: "m1", role: "user", content: "History message" }],
  });

test("picking a chat puts it in the URL, and a reload comes back to it", async ({
  page,
}) => {
  await twoThreads(page);
  await page.goto("/chat");

  await page.getByRole("button", { name: "E2E thread" }).click();
  await expect(page.getByText("History message")).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`[?&]c=${CONVERSATION_ID}`));

  await page.reload();

  // The thread itself, not just the URL — restoring the param without
  // fetching the messages would look identical until you read the page.
  await expect(page.getByText("History message")).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`[?&]c=${CONVERSATION_ID}`));
});

test("a thread URL opens that thread directly", async ({ page }) => {
  await twoThreads(page);
  await page.goto(`/chat?c=${CONVERSATION_ID}`);

  await expect(page.getByText("History message")).toBeVisible();
});

test("starting a new chat drops the param, and back returns to the thread", async ({
  page,
}) => {
  await twoThreads(page);
  await page.goto("/chat");

  await page.getByRole("button", { name: "E2E thread" }).click();
  await expect(page.getByText("History message")).toBeVisible();

  await page.getByRole("button", { name: "New chat" }).click();
  await expect(page.getByText("History message")).toBeHidden();
  await expect(page).not.toHaveURL(/[?&]c=/);

  // The param changes under a live component, so history is real navigation.
  await page.goBack();
  await expect(page.getByText("History message")).toBeVisible();
});
