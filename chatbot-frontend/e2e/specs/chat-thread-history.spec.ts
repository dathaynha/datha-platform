import { authedTest as test, expect } from "../fixtures";
import {
  dismissGlobalErrorDialog,
  mockChatApi,
  openStubbedThread,
  scrollToTopUntil,
  settleAtBottom,
} from "../chat-api-mock";

/** Thread history: initial page, older-message pagination, failure states. */

const RECENT = Array.from({ length: 12 }, (_, i) => ({
  id: `recent-${i}`,
  role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
  content: `Recent ${i} — ${"filler ".repeat(12)}`,
}));

const OLDER = Array.from({ length: 5 }, (_, i) => ({
  id: `older-${i}`,
  role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
  content: `Older ${i}`,
}));

test("renders the newest page; the hint appears only when nothing is older", async ({
  page,
}) => {
  await mockChatApi(page, { messages: RECENT, messagesHasMore: true });
  await openStubbedThread(page);

  await expect(page.getByText("Recent 11", { exact: false })).toBeVisible();
  // More history exists, so the "you have it all" hint stays away.
  await expect(
    page.getByText("Latest messages — scroll up for older."),
  ).toHaveCount(0);
});

test("shows the newest hint once the whole thread is loaded", async ({
  page,
}) => {
  await mockChatApi(page, { messages: RECENT, messagesHasMore: false });
  await openStubbedThread(page);

  await expect(
    page.getByText("Latest messages — scroll up for older."),
  ).toBeVisible();
});

test("fetches older messages when scrolled to the top", async ({ page }) => {
  const api = await mockChatApi(page, {
    messages: RECENT,
    messagesHasMore: true,
    olderMessages: OLDER,
  });
  await openStubbedThread(page);
  await settleAtBottom(page);

  await scrollToTopUntil(page, () => api.olderPageCursors.length > 0);

  await expect(page.getByText("Older 0")).toBeVisible();
  // The cursor is the oldest loaded row, so the server can page backwards.
  expect(api.olderPageCursors).toEqual(["recent-0"]);
});

test("does not page when the first response says there is nothing older", async ({
  page,
}) => {
  const api = await mockChatApi(page, {
    messages: RECENT,
    messagesHasMore: false,
    olderMessages: OLDER,
  });
  await openStubbedThread(page);
  await settleAtBottom(page);

  await page.locator(".chat-thread").evaluate((el) => el.scrollTo({ top: 0 }));
  // Negative assertion: give a wrong fetch time to fire before ruling it out.
  await page.waitForTimeout(500);

  await expect(page.getByText("Recent 0", { exact: false })).toBeVisible();
  expect(api.olderPageCursors).toEqual([]);
  await expect(page.getByText("Older 0")).toHaveCount(0);
});

test("a failed older page offers a retry", async ({ page }) => {
  const api = await mockChatApi(page, {
    messages: RECENT,
    messagesHasMore: true,
    olderMessagesStatus: 500,
  });
  await openStubbedThread(page);
  await settleAtBottom(page);

  await scrollToTopUntil(page, () => api.olderPageCursors.length > 0);

  await dismissGlobalErrorDialog(page);
  await expect(page.getByText("Couldn't load older messages.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
});

test("a failed thread load reports the error", async ({ page }) => {
  await mockChatApi(page, { messagesStatus: 500 });
  await openStubbedThread(page);

  await dismissGlobalErrorDialog(page);
  await expect(page.getByText("Could not load messages")).toBeVisible();
});

test("history renders attachment chips on a user turn", async ({ page }) => {
  await mockChatApi(page, {
    messages: [
      {
        id: "with-file",
        role: "user",
        content: "See attached",
        files: [
          { file_id: "f-1", name: "report.pdf", mime_type: "application/pdf" },
        ],
      },
    ],
  });
  await openStubbedThread(page);

  await expect(page.getByText("See attached")).toBeVisible();
  await expect(page.getByText("report.pdf")).toBeVisible();
});

test("an empty thread shows the empty-state copy", async ({ page }) => {
  await mockChatApi(page, { messages: [] });
  await page.goto("/chat");

  await expect(
    page.getByText(
      "Send a message to start the thread. Replies land here as you iterate.",
    ),
  ).toBeVisible();
});

test("new chat clears the open thread", async ({ page }) => {
  await mockChatApi(page, { messages: RECENT });
  await openStubbedThread(page);
  await expect(page.getByText("Recent 0", { exact: false })).toBeVisible();

  await page.getByRole("button", { name: "New chat" }).click();

  await expect(page.getByText("Recent 0", { exact: false })).toHaveCount(0);
  await expect(
    page.getByText(
      "Send a message to start the thread. Replies land here as you iterate.",
    ),
  ).toBeVisible();
});
