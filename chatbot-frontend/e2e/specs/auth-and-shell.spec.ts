import { test as anonTest, expect } from "@playwright/test";
import { authedTest as test } from "../fixtures";
import { mockChatApi } from "../chat-api-mock";

/** Standalone routing, guards, and app chrome (no shell host in this mode). */

anonTest.describe("unauthenticated", () => {
  // No storageState: hasValidAccessToken() is false.
  anonTest.use({ storageState: { cookies: [], origins: [] } });

  anonTest(
    "the guard sends an anonymous visitor to /login",
    async ({ page }) => {
      await page.goto("/chat");

      await expect(page).toHaveURL(/\/login$/);
      await expect(page.getByText("Sign in")).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Continue with Google" }),
      ).toBeVisible();
    },
  );

  anonTest("offers both Microsoft pools alongside Google", async ({ page }) => {
    await page.goto("/login");

    await expect(
      page.getByRole("button", {
        name: "Continue with Microsoft (Work / School)",
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Continue with Microsoft (Personal)" }),
    ).toBeVisible();
  });
});

test("an authenticated visitor lands on the app, not the login page", async ({
  page,
}) => {
  await mockChatApi(page);
  await page.goto("/");

  await expect(page).not.toHaveURL(/\/login/);
  await expect(
    page
      .getByRole("navigation", { name: "Chatbot sections" })
      .getByRole("link", { name: "Chat", exact: true }),
  ).toBeVisible();
});

test("the sub-header navigates to the chat page", async ({ page }) => {
  await mockChatApi(page, {
    messages: [{ id: "m1", role: "user", content: "Nav check" }],
  });

  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Chatbot sections" })
    .getByRole("link", { name: "Chat", exact: true })
    .click();

  await expect(page).toHaveURL(/\/chat$/);
  await expect(page.getByRole("heading", { name: "Chat" })).toBeVisible();
  await expect(page.getByPlaceholder("Write a message…")).toBeVisible();
});

test("switching language re-renders chat copy", async ({ page }) => {
  await mockChatApi(page);
  await page.goto("/chat");

  await expect(page.getByPlaceholder("Write a message…")).toBeVisible();

  // Language lives in the standalone toolbar (shell owns it when hosted).
  // v0.6.0: a chip that opens a menu, so the trigger is a button showing the
  // active code and the options are buttons in a popover.
  await page.locator("datha-lang-select button").first().click();
  await page
    .locator(".p-popover")
    .getByRole("button", { name: "Deutsch" })
    .click();

  await expect(
    page.getByPlaceholder("Wie kann ich dir heute helfen?"),
  ).toBeVisible();
});

test("the chat page keeps its landmarks for assistive tech", async ({
  page,
}) => {
  await mockChatApi(page);
  await page.goto("/chat");

  await expect(
    page.getByRole("complementary", { name: "Chats" }),
  ).toBeVisible();
  // The thread is a live log so streamed replies are announced.
  await expect(page.getByRole("log")).toBeVisible();
});
