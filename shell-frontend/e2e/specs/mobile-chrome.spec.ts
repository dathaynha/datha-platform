import { authedTest as test, expect, pickFromChipMenu } from "../fixtures";

/**
 * The shell's chrome on a phone.
 *
 * Every assertion here is a **rect**, not a selector. The survey on 2026-09-17
 * measured `scrollWidth - clientWidth === 0` on every route of all four
 * frontends and concluded nothing was wrong, while the screenshots showed a
 * 165px content column: the sidebar took 224px of a 390px screen and the
 * toolbar wrapped onto three rows. Content clipped inside its own container
 * rather than overflowing the document, so the one number that looked like a
 * responsiveness check could not see the fault at all.
 */

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };

/**
 * Waits for the layout to exist before anything is asserted about it.
 *
 * Not ceremony: `toBeHidden()` is satisfied by an element that is **not
 * attached**, so a hidden-assertion made in the same tick as `goto` passes on
 * an empty page — and therefore passes against the broken code too. The first
 * draft of this file did exactly that and was proved worthless by a red-proof
 * that stayed green while the sidebar was plainly rendering at 224px.
 */
const renderedShell = async (
  page: import("@playwright/test").Page,
  route = "/",
) => {
  await page.goto(route);
  await page.locator("main.shell-main").waitFor();
};

/** Apple's HIG minimum; Material says 48. Asserted against the smaller one. */
const MIN_TOUCH_TARGET = 44;

test.describe("shell chrome on a phone", () => {
  test.use({ viewport: PHONE });

  test("gives the page its full width and navigates from the bottom", async ({
    page,
  }) => {
    await renderedShell(page);

    // The sidebar is what took the width. Hidden, not narrowed: even the
    // collapsed rail is 56px, which is 15% of a 360px screen and permanent.
    await expect(page.locator(".shell-sidebar")).toHaveCount(1);
    await expect(page.locator(".shell-sidebar")).toBeHidden();

    const main = await page.locator("main.shell-main").boundingBox();
    expect(main).not.toBeNull();
    expect(main!.width).toBe(PHONE.width);

    // One row. Three rows measured ~155px before the two selects moved out.
    const toolbar = await page.locator(".shell-toolbar").boundingBox();
    expect(toolbar).not.toBeNull();
    expect(toolbar!.height).toBeLessThan(80);

    const bottomNav = page.getByTestId("shell-bottom-nav");
    await expect(bottomNav).toBeVisible();

    // Home + the three apps + Settings. Material 3 caps a bottom bar at five,
    // so this count is the design's limit and not an incidental number.
    const links = page.getByTestId("shell-bottom-link");
    await expect(links).toHaveCount(5);

    const count = await links.count();
    for (let index = 0; index < count; index += 1) {
      const box = await links.nth(index).boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
    }
  });

  test("keeps the bottom bar clear of the page content", async ({ page }) => {
    await renderedShell(page);

    const main = await page.locator("main.shell-main").boundingBox();
    const bottomNav = await page.getByTestId("shell-bottom-nav").boundingBox();
    expect(main).not.toBeNull();
    expect(bottomNav).not.toBeNull();

    // A `fixed` bar would overlap the last row of whatever is scrolled to the
    // bottom. This one is a flex sibling, so the two boxes must not intersect.
    expect(main!.y + main!.height).toBeLessThanOrEqual(bottomNav!.y + 1);
  });

  test("reaches theme and language through Settings", async ({ page }) => {
    await renderedShell(page);

    // They are gone from the toolbar on a phone — that is what stopped it
    // wrapping — so Settings is now the only way to them.
    await expect(page.locator(".shell-toolbar datha-theme-select")).toHaveCount(
      1,
    );
    await expect(
      page.locator(".shell-toolbar datha-theme-select"),
    ).toBeHidden();

    await page
      .getByTestId("shell-bottom-link")
      .filter({ hasText: /settings/i })
      .click();

    const themeCard = page.getByTestId("settings-theme");
    await expect(themeCard).toBeVisible();
    await expect(page.getByTestId("settings-lang")).toBeVisible();

    // Wired, not decorative: the control has to actually change the theme.
    await pickFromChipMenu(page, "datha-theme-select", /midnight/i, themeCard);
    await expect(page.locator("html")).toHaveClass(/dark/);

    // Back to Starlight so specs stay order-independent, as chrome.spec does.
    await pickFromChipMenu(page, "datha-theme-select", /starlight/i, themeCard);
    await expect(page.locator("html")).not.toHaveClass(/dark/);
  });
});

test.describe("shell chrome on a desktop", () => {
  test.use({ viewport: DESKTOP });

  test("keeps the sidebar and hides the bottom bar", async ({ page }) => {
    await renderedShell(page);

    await expect(page.locator(".shell-sidebar")).toBeVisible();
    await expect(page.getByTestId("shell-bottom-nav")).toHaveCount(1);
    await expect(page.getByTestId("shell-bottom-nav")).toBeHidden();
    await expect(
      page.locator(".shell-toolbar datha-theme-select"),
    ).toBeVisible();

    // The phone layout must not have cost the desktop its sidebar width.
    const sidebar = await page.locator(".shell-sidebar").boundingBox();
    expect(sidebar).not.toBeNull();
    expect(sidebar!.width).toBeGreaterThan(200);
  });
});
