import { expect, test } from "@playwright/test";
import { authedTest } from "../fixtures";

test.describe("unauthenticated", () => {
  test("redirects / to /login and shows the login card", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.locator("datha-login-card")).toBeVisible();
    await expect(
      page.getByRole("button", { name: /continue with google/i }),
    ).toBeVisible();
  });
});

authedTest.describe("authenticated", () => {
  authedTest("stays on home and renders the app grid", async ({ page }) => {
    await page.goto("/");
    await expect(page).not.toHaveURL(/\/login/);
    await expect(
      page.getByRole("heading", { name: "Your Applications" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /chatbot/i })).toBeVisible();
    await expect(
      page.getByRole("button", { name: /event store/i }),
    ).toBeVisible();
  });

  authedTest(
    "profile popover shows the seeded identity and logs out",
    async ({ page }) => {
      await page.goto("/");
      await page.getByRole("button", { name: "Open profile menu" }).click();
      await expect(page.getByText("E2E Tester")).toBeVisible();
      await expect(page.getByText("e2e@datha.local")).toBeVisible();
      await page.getByRole("button", { name: /log out/i }).click();
      await expect(page).toHaveURL(/\/login$/);
    },
  );
});

authedTest.describe("guards", () => {
  authedTest("authenticated visit to /login bounces home", async ({ page }) => {
    await page.goto("/login");
    await expect(page).not.toHaveURL(/\/login/);
    await expect(
      page.getByRole("heading", { name: "Your Applications" }),
    ).toBeVisible();
  });
});

test.describe("guards (unauthenticated)", () => {
  for (const path of ["/chatbot", "/event-store"]) {
    test(`deep link to ${path} redirects to /login`, async ({ page }) => {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login$/);
      await expect(page.locator("datha-login-card")).toBeVisible();
    });
  }
});
