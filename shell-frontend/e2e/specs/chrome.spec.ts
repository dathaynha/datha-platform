import { authedTest as test, expect, pickFromChipMenu } from "../fixtures";

test("theme select switches to Midnight and persists across reload", async ({
  page,
}) => {
  await page.goto("/");
  await pickFromChipMenu(page, "datha-theme-select", /midnight/i);
  await expect(page.locator("html")).toHaveClass(/dark/);

  await page.reload();
  await expect(page.locator("html")).toHaveClass(/dark/);

  // back to Starlight so specs stay order-independent
  await pickFromChipMenu(page, "datha-theme-select", /starlight/i);
  await expect(page.locator("html")).not.toHaveClass(/dark/);
});

test("language select switches home copy to German and back", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Your Applications" }),
  ).toBeVisible();

  await pickFromChipMenu(page, "datha-lang-select", /Deutsch/);
  await expect(
    page.getByRole("heading", { name: "Ihre Anwendungen" }),
  ).toBeVisible();

  await pickFromChipMenu(page, "datha-lang-select", /English/);
  await expect(
    page.getByRole("heading", { name: "Your Applications" }),
  ).toBeVisible();
});

test("sidebar collapses and expands", async ({ page }) => {
  await page.goto("/");
  const chatbotLink = page.getByRole("link", { name: /chatbot/i });
  await expect(chatbotLink).toBeVisible();

  await page.getByRole("button", { name: /collapse sidebar/i }).click();
  await expect(chatbotLink.getByText("Chatbot")).toBeHidden();

  await page.getByRole("button", { name: /expand sidebar/i }).click();
  await expect(chatbotLink.getByText("Chatbot")).toBeVisible();
});

test("collapsed sidebar icons show tooltips, expanded ones do not", async ({
  page,
}) => {
  await page.goto("/");
  // Scoped to the sidebar: the compact bottom bar is a second <nav> with its
  // own Home link, so a bare `nav a[href="/"]` matches two elements.
  const homeLink = page.locator('.shell-sidebar a[href="/"]');

  await page.getByRole("button", { name: /collapse sidebar/i }).click();
  await expect(homeLink.getByText("Home")).toBeHidden();
  await homeLink.hover();
  await expect(page.locator(".p-tooltip")).toHaveText("Home");

  await page.getByRole("button", { name: /expand sidebar/i }).click();
  await expect(homeLink.getByText("Home")).toBeVisible();
  await homeLink.hover();
  await page.waitForTimeout(300); // tooltip would have appeared by now
  await expect(page.locator(".p-tooltip")).toHaveCount(0);
});
