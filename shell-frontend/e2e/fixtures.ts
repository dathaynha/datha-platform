import { test as base } from "@playwright/test";
import { STORAGE_STATE_PATH } from "./global-setup";

/** Authenticated test: browser context pre-seeded by global-setup. */
export const authedTest = base.extend({
  storageState: STORAGE_STATE_PATH,
});

export { expect } from "@playwright/test";

/**
 * Is a remote's entry served right now? Remote-dependent specs self-skip on the
 * branch they cannot reproduce, so shell-only CI still exercises the offline
 * contract and a full local platform exercises the hosted one.
 */
export const isRemoteUp = (entry: string): Promise<boolean> =>
  fetch(entry)
    .then((r) => r.ok)
    .catch(() => false);

/**
 * Picks an option from one of the chrome chip menus.
 *
 * `@datha/platform-ui` v0.6.0 replaced the theme and language dropdowns with a
 * chip that opens a menu, so `.p-select` plus `getByRole("option")` no longer
 * describes the interaction — the options are buttons inside a popover. Seven
 * specs across this repo drove the old shape; they share this instead of each
 * learning the new one.
 */
export const pickFromChipMenu = async (
  page: import("@playwright/test").Page,
  control: "datha-theme-select" | "datha-lang-select",
  option: RegExp,
  scope?: import("@playwright/test").Locator,
): Promise<void> => {
  const root = scope ?? page;
  await root.locator(`${control} button`).first().click();
  await page
    .locator(".p-popover")
    .getByRole("button", { name: option })
    .click();
};
