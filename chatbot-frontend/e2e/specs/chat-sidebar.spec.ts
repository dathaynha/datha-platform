import { authedTest as test, expect } from "../fixtures";
import {
  CONVERSATION_ID,
  DEFAULT_CONVERSATION,
  dismissGlobalErrorDialog,
  mockChatApi,
} from "../chat-api-mock";

/** Sidebar: listing, selection, rename, delete, pagination, failure states. */

const SECOND_ID = "66666666-6666-6666-6666-666666666666";

test("lists conversations and opens one", async ({ page }) => {
  await mockChatApi(page, {
    conversations: [
      DEFAULT_CONVERSATION,
      { id: SECOND_ID, title: "Second thread" },
    ],
    messages: [{ id: "m1", role: "user", content: "History message" }],
  });

  await page.goto("/chat");

  await expect(page.getByRole("button", { name: "E2E thread" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Second thread" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "E2E thread" }).click();
  await expect(page.getByText("History message")).toBeVisible();
});

test("a conversation with no title shows the untitled fallback", async ({
  page,
}) => {
  await mockChatApi(page, { conversations: [{ id: CONVERSATION_ID }] });

  await page.goto("/chat");

  await expect(
    page.getByRole("button", { name: "Untitled chat" }),
  ).toBeVisible();
});

test("empty history shows the empty state", async ({ page }) => {
  await mockChatApi(page, { conversations: [] });

  await page.goto("/chat");

  await expect(page.getByText("No conversations yet")).toBeVisible();
});

test("a failed list reports the error and retries successfully", async ({
  page,
}) => {
  await mockChatApi(page, { conversationsStatus: 500 });
  await page.goto("/chat");

  // The global HTTP error dialog fronts the failure and blocks the page until
  // dismissed; the sidebar keeps its own inline error underneath.
  await dismissGlobalErrorDialog(page);

  await expect(page.getByText("Could not load chats")).toBeVisible();

  // Re-stub with a working list, then retry.
  await mockChatApi(page, { conversations: [DEFAULT_CONVERSATION] });
  await page.getByRole("button", { name: "Try again" }).click();

  await expect(page.getByRole("button", { name: "E2E thread" })).toBeVisible();
});

test("renames a conversation", async ({ page }) => {
  const api = await mockChatApi(page);
  await page.goto("/chat");

  await page.getByRole("button", { name: "Edit chat title" }).click();
  const input = page.getByRole("textbox", { name: "Edit chat title" });
  await input.fill("Renamed thread");
  await input.press("Enter");

  await expect.poll(() => api.patchedTitles.length).toBe(1);
  expect(api.patchedTitles[0]).toMatchObject({ title: "Renamed thread" });
  await expect(
    page.getByRole("button", { name: "Renamed thread" }),
  ).toBeVisible();
});

test("a failed rename reports the error", async ({ page }) => {
  await mockChatApi(page, { patchTitleStatus: 500 });
  await page.goto("/chat");

  await page.getByRole("button", { name: "Edit chat title" }).click();
  const input = page.getByRole("textbox", { name: "Edit chat title" });
  await input.fill("Doomed rename");
  await input.press("Enter");

  await dismissGlobalErrorDialog(page);

  await expect(page.getByText("Could not save the title")).toBeVisible();
});

test("deletes a conversation after confirming", async ({ page }) => {
  const api = await mockChatApi(page);
  await page.goto("/chat");

  await page.getByRole("button", { name: "Delete chat" }).click();
  await expect(
    page.getByText("Delete this chat and all its messages permanently?"),
  ).toBeVisible();

  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Confirm", exact: true })
    .click();

  await expect.poll(() => api.deletedConversations).toEqual([CONVERSATION_ID]);
  await expect(page.getByRole("button", { name: "E2E thread" })).toHaveCount(0);
});

test("cancelling the delete dialog keeps the conversation", async ({
  page,
}) => {
  const api = await mockChatApi(page);
  await page.goto("/chat");

  await page.getByRole("button", { name: "Delete chat" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();

  await expect(page.getByRole("button", { name: "E2E thread" })).toBeVisible();
  expect(api.deletedConversations).toEqual([]);
});

test("loads a second page of conversations, then reports all loaded", async ({
  page,
}) => {
  // A full first page (50 = SIDEBAR_CONVERSATIONS_PAGE_SIZE) means "maybe more".
  const firstPage = Array.from({ length: 50 }, (_, i) => ({
    id: `c-${i}`,
    title: `Thread ${i}`,
  }));

  await mockChatApi(page, {
    conversations: firstPage,
    conversationPages: [[{ id: "c-50", title: "Thread 50" }]],
  });

  await page.goto("/chat");
  await expect(page.getByRole("button", { name: "Thread 0" })).toBeVisible();

  await page.getByRole("button", { name: "Load more chats" }).click();
  await expect(page.getByRole("button", { name: "Thread 50" })).toBeVisible();

  // Short page → nothing left to fetch.
  await expect(
    page.getByText("All chats in this list are shown."),
  ).toBeVisible();
});

test("keeps the history list and the thread from touching", async ({
  page,
}) => {
  // Aligned with messenger-frontend on 2026-09-10: both products render the two
  // panes as inset panels rather than letting them meet on a hard border.
  await mockChatApi(page, { conversations: [DEFAULT_CONVERSATION] });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/chat");
  await expect(page.getByRole("button", { name: "E2E thread" })).toBeVisible();

  const sidebar = await page.locator("aside.chat-sidebar").boundingBox();
  const stage = await page.locator("div.chat-stage").boundingBox();
  if (!sidebar || !stage) throw new Error("panes not laid out");

  expect(stage.x - (sidebar.x + sidebar.width)).toBeGreaterThanOrEqual(8);
  expect(sidebar.x).toBeGreaterThanOrEqual(8);

  const radius = await page
    .locator("div.chat-stage")
    .evaluate((el) => parseFloat(getComputedStyle(el).borderTopLeftRadius));
  expect(radius).toBeGreaterThan(0);
});
