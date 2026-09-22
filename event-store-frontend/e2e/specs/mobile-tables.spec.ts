import { authedTest as test, expect } from "../fixtures";
import { mockEventStoreApi } from "../event-store-api-mock";

/**
 * The ops tables on a phone.
 *
 * Measured 2026-09-17: both lists showed two of six columns at 390px and the
 * rest were simply gone off the right edge. Nothing announced it — the table
 * scrolls inside its own container, so the document's own
 * `scrollWidth - clientWidth` read 0 and the page looked fine to every number
 * that was being checked. These assertions are therefore about cells and their
 * rects, not about the table existing.
 */

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };

/** Waits for rows, so no assertion is made against an unrendered page. */
const renderedList = async (
  page: import("@playwright/test").Page,
  route: string,
) => {
  await page.goto(route);
  await page.locator("tbody tr").first().waitFor();
};

test.describe("ops tables on a phone", () => {
  test.use({ viewport: PHONE });

  for (const { route, label } of [
    { route: "/events", label: "events" },
    { route: "/dlq", label: "dlq" },
  ]) {
    /**
     * Every column survives, and the table scrolls sideways to show them.
     *
     * This replaces the 2026-09-17 rule that dropped the supporting columns
     * below 40rem. dathq rejected it on use — "2 columns is a little bit not
     * information enough" — and the survey agrees: an ops list of identifiers
     * is the case where freezing a column and scrolling beats both dropping
     * columns and stacking each row into a card.
     */
    test(`${label} keeps every column and scrolls sideways`, async ({
      page,
    }) => {
      await mockEventStoreApi(page);
      await renderedList(page, route);

      const headers = page.locator("thead th");
      const count = await headers.count();
      let rendered = 0;
      for (let index = 0; index < count; index += 1) {
        const box = await headers.nth(index).boundingBox();
        if (box !== null && box.width > 0) rendered += 1;
      }
      // Nothing is dropped any more — same count the desktop test asserts.
      expect(rendered).toBe(count);

      const scroller = page.locator(".p-datatable-table-container");
      const metrics = await scroller.evaluate((el) => ({
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        overflowX: getComputedStyle(el).overflowX,
        docOverflow:
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      }));

      // There is genuinely more to reach...
      expect(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth);
      expect(metrics.overflowX).toBe("auto");
      // ...and it is reached inside the table, never by scrolling the page.
      // A document that scrolls sideways is the bug this replaces, not a
      // milder version of it.
      expect(metrics.docOverflow).toBeLessThanOrEqual(1);
    });

    test(`${label} freezes the first column while the rest scrolls`, async ({
      page,
    }) => {
      await mockEventStoreApi(page);
      await renderedList(page, route);

      const frozen = page.locator("tbody td.es-table__sticky").first();
      const before = await frozen.boundingBox();
      expect(before).not.toBeNull();

      const moved = await page
        .locator(".p-datatable-table-container")
        .evaluate((el) => {
          el.scrollLeft = el.scrollWidth;
          return el.scrollLeft;
        });
      // The premise: the scroll actually happened, so a stationary cell means
      // something. Without this the assertion below passes on a table that
      // cannot scroll at all.
      expect(moved).toBeGreaterThan(0);

      const after = await frozen.boundingBox();
      expect(Math.round(after!.x)).toBe(Math.round(before!.x));

      // Frozen is only useful if it is also opaque: these cells are
      // transparent by default and take their colour from the card, so a
      // see-through one shows the scrolled columns straight through it.
      const alpha = await frozen.evaluate((el) => {
        const bg = getComputedStyle(el).backgroundColor;
        const m = /rgba?\(([^)]+)\)/.exec(bg);
        const parts = m ? m[1].split(",").map((n) => Number(n.trim())) : [];
        return parts.length === 4 ? parts[3] : 1;
      });
      expect(alpha).toBe(1);
    });
  }

  /**
   * The frozen header has to paint above the ones sliding under it.
   *
   * Every `th` is already `position: sticky; z-index: 1` from PrimeNG's
   * scrollable header, so the frozen one tied with its neighbours and DOM
   * order decided — "Timestamp" and "Service" rendered on top of each other
   * (measured 2026-09-20).
   */
  test("the frozen header outranks the columns sliding under it", async ({
    page,
  }) => {
    await mockEventStoreApi(page);
    await renderedList(page, "/events");

    const z = await page.evaluate(() => {
      const ths = Array.from(
        document.querySelectorAll("thead th"),
      ) as HTMLElement[];
      return {
        frozen: Number(getComputedStyle(ths[0]).zIndex),
        others: ths.slice(1).map((t) => Number(getComputedStyle(t).zIndex)),
      };
    });
    expect(z.others.length).toBeGreaterThan(0);
    for (const other of z.others) expect(z.frozen).toBeGreaterThan(other);
  });

  test("a row still opens its detail", async ({ page }) => {
    await mockEventStoreApi(page);
    await renderedList(page, "/events");

    await page.locator("tbody tr").first().click();
    await expect(page).toHaveURL(/\/events\/.+/);
  });
});

test.describe("ops tables on a desktop", () => {
  test.use({ viewport: DESKTOP });

  test("keeps every column", async ({ page }) => {
    await mockEventStoreApi(page);
    await renderedList(page, "/events");

    const headers = page.locator("thead th");
    const count = await headers.count();
    let visible = 0;
    for (let index = 0; index < count; index += 1) {
      const box = await headers.nth(index).boundingBox();
      if (box !== null && box.width > 0) visible += 1;
    }
    // Six: timestamp, type, service, entity, correlation, action.
    expect(visible).toBe(6);
  });

  /**
   * The columns are only worth keeping if they read as secondary.
   *
   * `.es-table__primary` and `.es-table__secondary` set the list's hierarchy,
   * and for a while they set nothing at all: the blanket
   * `.es-table .p-datatable-tbody > tr > td` rule in `_primeng-table-overrides`
   * declares `color` at (0,3,2), which a single class on the cell cannot
   * outrank — so every cell rendered `rgb(30, 41, 59)` (measured 2026-09-18).
   * The cell colour now comes from `--es-cell-ink`, which a column class sets
   * on the cell itself with no specificity fight.
   *
   * Asserted as a difference, not against a token: pinning `rgb(…)` would
   * break on any theme change and prove nothing more.
   */
  test("distinguishes primary from secondary columns", async ({ page }) => {
    await mockEventStoreApi(page);
    await renderedList(page, "/events");

    const primary = page.locator("tbody .es-table__primary").first();
    const secondary = page.locator("tbody .es-table__secondary").first();
    await expect(primary).toBeVisible();
    await expect(secondary).toBeVisible();

    const ink = (locator: typeof primary) =>
      locator.evaluate((el) => {
        const style = getComputedStyle(el);
        return { color: style.color, fontWeight: style.fontWeight };
      });

    const [primaryInk, secondaryInk] = await Promise.all([
      ink(primary),
      ink(secondary),
    ]);

    expect(secondaryInk.color).not.toBe(primaryInk.color);
    expect(Number(primaryInk.fontWeight)).toBeGreaterThan(
      Number(secondaryInk.fontWeight),
    );
  });
});
