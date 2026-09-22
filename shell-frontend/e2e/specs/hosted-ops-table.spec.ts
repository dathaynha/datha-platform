import { authedTest as test, expect, isRemoteUp } from "../fixtures";

const EVENT_STORE_ENTRY = "http://localhost:4002/remoteEntry.js";
const PHONE = { width: 390, height: 844 };

/**
 * The event-store list at phone width, **hosted**.
 *
 * This cannot be written in the remote's own suite, and the reason is the
 * fault it guards: a Module Federation host loads a remote's component styles
 * with its JavaScript and never loads its global stylesheet. The compact table
 * rules lived in `event-store-frontend/src/styles/_table.scss` first, so the
 * lists were responsive standalone at :4002 and, hosted here, still rendered
 * six columns in a 832px table inside a 390px viewport — measured, 2026-09-17.
 * Moving them into the page components is what makes them travel.
 *
 * What those rules *do* changed on 2026-09-20: the list keeps every column and
 * scrolls sideways with the first frozen, rather than dropping three. The
 * guard is unchanged in purpose — it still asks whether the remote's own
 * compact rules reached it inside the shell at all.
 */
test.describe("hosted event-store list on a phone", () => {
  test.use({ viewport: PHONE });

  test("keeps every column and scrolls inside the table, hosted too", async ({
    page,
  }) => {
    test.skip(
      !(await isRemoteUp(EVENT_STORE_ENTRY)),
      "event-store remote not running — start it for hosted coverage",
    );

    await page.route("**/api/event-store/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: [
            {
              id: "e1",
              timestamp: "2026-09-01T10:00:00.000Z",
              type: "file.uploaded",
              service: "file-service",
              entityId: "file-aaa",
              correlationId: "corr-aaa",
              payload: {},
            },
          ],
          meta: { total: 1, page: 1, pageSize: 25 },
        }),
      }),
    );

    await page.goto("/event-store/events");
    await page.locator("tbody tr").first().waitFor({ timeout: 30_000 });

    const headers = page.locator("thead th");
    const count = await headers.count();
    let rendered = 0;
    for (let index = 0; index < count; index += 1) {
      const box = await headers.nth(index).boundingBox();
      if (box !== null && box.width > 0) rendered += 1;
    }
    // Every column, hosted as well as standalone. Until 2026-09-20 this
    // dropped to three; dathq rejected that on use and the list now freezes
    // its first column and scrolls instead.
    expect(rendered).toBe(count);

    // The distinction that matters: columns may sit past the right edge, but
    // the *document* must not be what scrolls to reach them. Off-screen inside
    // a scroller is a feature; off-screen inside `overflow: hidden` was the
    // 2026-09-17 bug, and a page that scrolls sideways is a third thing that
    // would fight the vertical scroll this layout needs.
    const scroll = await page.evaluate(() => {
      const el = document.querySelector(
        ".p-datatable-table-container",
      ) as HTMLElement;
      return {
        inner: el.scrollWidth - el.clientWidth,
        overflowX: getComputedStyle(el).overflowX,
        doc:
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      };
    });
    expect(scroll.inner).toBeGreaterThan(0);
    expect(scroll.overflowX).toBe("auto");
    expect(scroll.doc).toBeLessThanOrEqual(1);

    // And the frozen column stays put, which is what makes a scrolled row
    // still identifiable.
    const frozen = page.locator("tbody td.es-table__sticky").first();
    const before = await frozen.boundingBox();
    const moved = await page
      .locator(".p-datatable-table-container")
      .evaluate((el) => {
        el.scrollLeft = el.scrollWidth;
        return el.scrollLeft;
      });
    expect(moved).toBeGreaterThan(0);
    const after = await frozen.boundingBox();
    expect(Math.round(after!.x)).toBe(Math.round(before!.x));
  });
});

/**
 * A phone held sideways: wide viewport, no height, and a sidebar.
 *
 * 667x375 is the case every width-keyed breakpoint misses. The viewport reads
 * as a small tablet, so the shell keeps its 224px sidebar and the table is left
 * 334px — while `max-width: 639.98px` never fires and all six columns stay.
 * Worse, the page is built to fill the viewport and scroll the table inside it,
 * and at 311px of usable height there was nothing left to give: the table
 * measured **0px tall at top=549**, below the fold, with `overflow: hidden` on
 * every ancestor. Present, correct, unreachable (measured 2026-09-18).
 *
 * The columns are now keyed on the table's own width with a container query,
 * and short viewports let the page scroll instead of fill. Since 2026-09-20
 * the narrow rule scrolls to the supporting columns rather than dropping
 * them, so this asserts they are reachable, not absent.
 */
const PORTRAIT_ROWS = Array.from({ length: 25 }, (_, i) => ({
  id: `e${i}`,
  timestamp: "2026-09-01T10:00:00.000Z",
  type: "file.uploaded",
  service: "file-service",
  entityId: `file-${i}`,
  correlationId: `corr-${i}`,
  payload: {},
}));

/**
 * The same fault as the landscape one below, reached by the other axis.
 *
 * A phone in **portrait** is 375x667: tall enough that the `max-height: 30rem`
 * rule written for landscape never fires, and still far too small for a layout
 * that spends the viewport on a heading, a description and a filter card before
 * the table gets whatever is left — which is nothing. Measured hosted on
 * 2026-09-20: `.es-table-wrap` **0px tall at top=616** and the paginator at
 * **top=676 in a 667px viewport**, behind `overflow: hidden`. dathq reported it
 * with a screenshot; it predates the container migration (the pre-change tree
 * measured 0px at top=624, i.e. slightly worse).
 *
 * Narrow now scrolls the page and lets the table take its natural height, so
 * there is exactly one scroller rather than a table scrolling inside a page.
 */
test.describe("hosted event-store list on a phone in portrait", () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test("scrolls the page once and gives the table its rows", async ({
    page,
  }) => {
    test.skip(
      !(await isRemoteUp(EVENT_STORE_ENTRY)),
      "event-store remote not running — start it for hosted coverage",
    );

    await page.route("**/api/event-store/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: PORTRAIT_ROWS,
          meta: { total: 25, page: 1, pageSize: 25 },
        }),
      }),
    );

    await page.goto("/event-store/events");
    await page.locator("tbody tr").first().waitFor({ timeout: 30_000 });

    // A rect, not a selector: the failure was a 0px-tall element that every
    // existence assertion was perfectly happy with.
    const wrap = await page.locator(".es-table-wrap").boundingBox();
    expect(wrap).not.toBeNull();
    expect(wrap!.height).toBeGreaterThan(400);

    // One scroller. A capped table inside a scrolling page is two, which on a
    // touch screen is the worse of the two arrangements.
    const scroll = await page.evaluate(() => {
      const pick = (sel: string) => {
        const el = document.querySelector(sel) as HTMLElement;
        return { scrollH: el.scrollHeight, clientH: el.clientHeight };
      };
      return {
        body: pick(".events-page-body"),
        container: pick(".p-datatable-table-container"),
      };
    });
    expect(scroll.body.scrollH).toBeGreaterThan(scroll.body.clientH);
    expect(scroll.container.scrollH).toBe(scroll.container.clientH);

    // The paginator was below the fold behind `overflow: hidden`; it must now
    // be reachable, and inside the card rather than spilling out of it.
    const reachable = await page.evaluate(() => {
      const body = document.querySelector(".events-page-body") as HTMLElement;
      body.scrollTop = body.scrollHeight;
      const pager = document
        .querySelector(".ops-paginator")!
        .getBoundingClientRect();
      const card = document
        .querySelector(".events-results-card")!
        .getBoundingClientRect();
      return {
        pagerInView: pager.top >= 0 && pager.bottom <= window.innerHeight + 1,
        pagerInCard: pager.bottom <= card.bottom + 1,
      };
    });
    expect(reachable.pagerInView).toBe(true);
    expect(reachable.pagerInCard).toBe(true);
  });
});

test.describe("hosted event-store list on a landscape phone", () => {
  test.use({ viewport: { width: 667, height: 375 } });

  test("gives the table a real size and scrolls to the columns that do not fit", async ({
    page,
  }) => {
    test.skip(
      !(await isRemoteUp(EVENT_STORE_ENTRY)),
      "event-store remote not running — start it for hosted coverage",
    );

    await page.route("**/api/event-store/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: [
            {
              id: "e1",
              timestamp: "2026-09-01T10:00:00.000Z",
              type: "file.uploaded",
              service: "file-service",
              entityId: "file-aaa",
              correlationId: "corr-aaa",
              payload: {},
            },
          ],
          meta: { total: 1, page: 1, pageSize: 25 },
        }),
      }),
    );

    await page.goto("/event-store/events");
    await page.locator("tbody tr").first().waitFor({ timeout: 30_000 });

    // A rect, not a selector: the failure mode was a 0px-tall element that
    // every existence assertion was perfectly happy with.
    const table = page.locator(".p-datatable-table-container");
    const box = await table.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThan(100);

    // The container query keys on the table's width (334px here), not the
    // 667px viewport — and since 2026-09-20 what it does at that width is
    // freeze the first column and scroll, rather than drop the supporting
    // three. Every column is still rendered.
    await expect(page.locator("thead .es-table__secondary")).toHaveCount(3);
    for (const cell of await page.locator("thead .es-table__secondary").all())
      await expect(cell).toBeVisible();

    // The sideways travel belongs to the table. A landscape phone is the
    // viewport most likely to leak it onto the document, where it would fight
    // the vertical page scroll this same layout depends on.
    const scroll = await page.evaluate(() => {
      const el = document.querySelector(
        ".p-datatable-table-container",
      ) as HTMLElement;
      return {
        inner: el.scrollWidth - el.clientWidth,
        doc:
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      };
    });
    expect(scroll.inner).toBeGreaterThan(0);
    expect(scroll.doc).toBeLessThanOrEqual(1);

    // And the whole page is reachable, which is what `overflow: hidden` on a
    // filling layout took away.
    const reachable = await page.evaluate(() => {
      const body = document.querySelector(".ops-page-body") as HTMLElement;
      body.scrollTop = body.scrollHeight;
      const rect = document
        .querySelector(".p-datatable-table-container")!
        .getBoundingClientRect();
      return rect.top < window.innerHeight && rect.bottom > 0;
    });
    expect(reachable).toBe(true);
  });
});

/**
 * The same fault, one file further in: the *ink* of those columns.
 *
 * `.es-table__primary` and `.es-table__secondary` carry the list's visual
 * hierarchy — the identifying column dark and medium-weight, the supporting
 * ones muted and a size down. Both rules live in
 * `event-store-frontend/src/styles/_table.scss`, which `base.scss` imports,
 * which is to say **the global sheet**. The compact rules were moved out of
 * that file in the mobile wave and these were left behind, so hosted here the
 * two column kinds render identically and the hierarchy is simply absent.
 *
 * Asserted as a *difference* rather than against a token value: the point is
 * that the two kinds are distinguishable, and pinning `rgb(…)` would break on
 * any theme change while proving nothing extra.
 */
test.describe("hosted event-store list ink", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("keeps the primary/secondary hierarchy inside the shell", async ({
    page,
  }) => {
    test.skip(
      !(await isRemoteUp(EVENT_STORE_ENTRY)),
      "event-store remote not running — start it for hosted coverage",
    );

    await page.route("**/api/event-store/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: [
            {
              id: "e1",
              timestamp: "2026-09-01T10:00:00.000Z",
              type: "file.uploaded",
              service: "file-service",
              entityId: "file-aaa",
              correlationId: "corr-aaa",
              payload: {},
            },
          ],
          meta: { total: 1, page: 1, pageSize: 25 },
        }),
      }),
    );

    await page.goto("/event-store/events");
    await page.locator("tbody tr").first().waitFor({ timeout: 30_000 });

    const primary = page.locator("tbody .es-table__primary").first();
    const secondary = page.locator("tbody .es-table__secondary").first();
    // Present *and* laid out — a hidden cell reports a colour just as happily.
    await expect(primary).toBeVisible();
    await expect(secondary).toBeVisible();

    const ink = async (locator: typeof primary) =>
      locator.evaluate((el) => {
        const style = getComputedStyle(el);
        return { color: style.color, fontWeight: style.fontWeight };
      });

    const [primaryInk, secondaryInk] = await Promise.all([
      ink(primary),
      ink(secondary),
    ]);

    // Colour and weight carry the hierarchy. Size deliberately does not: every
    // body cell takes `--datha-form-font-size` from the table rule, so a
    // font-size assertion here passes or fails on nothing.
    expect(secondaryInk.color).not.toBe(primaryInk.color);
    expect(Number(primaryInk.fontWeight)).toBeGreaterThan(
      Number(secondaryInk.fontWeight),
    );
  });
});
