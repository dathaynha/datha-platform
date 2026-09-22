import { expect, test } from "@playwright/test";
import { mockEventStoreApi } from "../event-store-api-mock";
import { authedTest } from "../fixtures";

/**
 * Standalone chrome: guards, the lib sub-header (v0.5.0) and i18n. The hosted
 * variant — same remote mounted by the shell at /event-store — is covered by
 * the shell's own remotes.spec.ts.
 */

test.describe("unauthenticated", () => {
  test("redirects / to /login and shows the login card", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.locator("datha-login-card")).toBeVisible();
    await expect(
      page.getByRole("button", { name: /continue with google/i }),
    ).toBeVisible();
  });

  for (const path of ["/events", "/dlq"]) {
    test(`deep link to ${path} redirects to /login`, async ({ page }) => {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login$/);
      await expect(page.locator("datha-login-card")).toBeVisible();
    });
  }
});

authedTest.describe("authenticated chrome", () => {
  authedTest(
    "renders the overview and the sub-header tabs",
    async ({ page }) => {
      await mockEventStoreApi(page);
      await page.goto("/");

      await expect(
        page.getByRole("heading", { name: "Event Store", level: 1 }),
      ).toBeVisible();

      const nav = page.getByRole("navigation", {
        name: "Event store sections",
      });
      await expect(nav.getByRole("link", { name: "Overview" })).toBeVisible();
      await expect(nav.getByRole("link", { name: "Events" })).toBeVisible();
      await expect(nav.getByRole("link", { name: "DLQ" })).toBeVisible();
    },
  );

  authedTest(
    "marks only the active tab with aria-current",
    async ({ page }) => {
      await mockEventStoreApi(page);
      await page.goto("/");

      const nav = page.getByRole("navigation", {
        name: "Event store sections",
      });
      await expect(nav.getByRole("link", { name: "Overview" })).toHaveAttribute(
        "aria-current",
        "page",
      );
      await expect(
        nav.getByRole("link", { name: "Events" }),
      ).not.toHaveAttribute("aria-current", "page");

      await nav.getByRole("link", { name: "Events" }).click();
      await expect(page).toHaveURL(/\/events$/);
      await expect(nav.getByRole("link", { name: "Events" })).toHaveAttribute(
        "aria-current",
        "page",
      );
      // Overview is `exact`, so it must drop out on a child route.
      await expect(
        nav.getByRole("link", { name: "Overview" }),
      ).not.toHaveAttribute("aria-current", "page");
    },
  );

  authedTest("sub-header navigates to the DLQ page", async ({ page }) => {
    await mockEventStoreApi(page);
    await page.goto("/");

    await page
      .getByRole("navigation", { name: "Event store sections" })
      .getByRole("link", { name: "DLQ" })
      .click();

    await expect(page).toHaveURL(/\/dlq$/);
    await expect(
      page.getByRole("heading", { name: "Dead letter queue" }),
    ).toBeVisible();
  });

  authedTest(
    "language select switches the page copy to German",
    async ({ page }) => {
      await mockEventStoreApi(page);
      await page.goto("/events");
      // EVENTS_PAGE.TITLE is "Events" in both locales — assert on a column
      // header that actually differs, or the spec proves nothing.
      const timestampHeader = page.getByRole("columnheader", {
        name: "Timestamp",
      });
      await expect(timestampHeader).toBeVisible();

      // v0.6.0: a chip that opens a menu, so the options are buttons in a
      // popover rather than a select's options.
      await page.locator("datha-lang-select button").first().click();
      await page
        .locator(".p-popover")
        .getByRole("button", { name: "Deutsch" })
        .click();

      await expect(
        page.getByRole("columnheader", { name: "Zeitstempel" }),
      ).toBeVisible();

      // Back to English so specs stay order-independent.
      // v0.6.0: a chip that opens a menu, so the options are buttons in a
      // popover rather than a select's options.
      await page.locator("datha-lang-select button").first().click();
      await page
        .locator(".p-popover")
        .getByRole("button", { name: "English" })
        .click();
      await expect(timestampHeader).toBeVisible();
    },
  );

  authedTest("profile popover shows the seeded identity", async ({ page }) => {
    await mockEventStoreApi(page);
    await page.goto("/");

    await page.getByRole("button", { name: "Account menu" }).click();
    await expect(page.getByText("E2E Tester")).toBeVisible();
    await expect(page.getByText("e2e@datha.local")).toBeVisible();
  });
});
