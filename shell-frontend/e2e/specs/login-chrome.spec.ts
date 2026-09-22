import { expect, test } from "@playwright/test";
import { pickFromChipMenu } from "../fixtures";

/** The unauthenticated layout carries its own theme + language controls. */
test("login page theme select flips to Midnight", async ({ page }) => {
  await page.goto("/login");
  await pickFromChipMenu(page, "datha-theme-select", /midnight/i);
  await expect(page.locator("html")).toHaveClass(/dark/);
});

test("login page language select flips copy to German", async ({ page }) => {
  await page.goto("/login");
  await pickFromChipMenu(page, "datha-lang-select", /Deutsch/);
  await expect(
    page.getByRole("button", { name: /mit google fortfahren/i }),
  ).toBeVisible();
});
