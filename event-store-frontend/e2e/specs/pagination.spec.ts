import { authedTest as test, expect } from "../fixtures";
import { makeDlqRecords, mockEventStoreApi } from "../event-store-api-mock";

/**
 * The ops lists page properly.
 *
 * They used to offer two text buttons, Previous and Next, and nothing else:
 * no page numbers, no way to reach the first or last page, and no control over
 * how many rows come back — on a list of 715 records, reaching the end meant
 * fifteen clicks (dathq, 2026-09-19). Replaced with PrimeNG's paginator, which
 * is the component this stack already ships for exactly this.
 *
 * Asserted on the **requests**, not on the buttons: a paginator that renders
 * page numbers and asks the server for the wrong slice looks completely correct.
 */
/** Query of the most recent GET /events. */
const lastQuery = (queries: URLSearchParams[]) => queries[queries.length - 1];

const manyEvents = Array.from({ length: 120 }, (_, i) => ({
  id: `e${String(i).padStart(3, "0")}`,
  timestamp: "2026-09-01T10:00:00.000Z",
  type: "file.uploaded",
  service: "file-service",
  entityId: `file-${i}`,
  correlationId: `corr-${i}`,
  ownerId: "google_aaa",
  payload: {},
}));

test.describe("events pagination", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("offers first, last and numbered pages, and asks for the right slice", async ({
    page,
  }) => {
    const recorder = await mockEventStoreApi(page, { events: manyEvents });
    await page.goto("/events");
    await page.locator("tbody tr").first().waitFor();

    const pager = page.locator(".ops-pagination");
    await expect(pager).toBeVisible();

    // 120 records at 50 a page is three pages, so the controls the old pager
    // never had must all be present.
    await expect(pager.locator('[aria-label="First page"]')).toBeVisible();
    await expect(pager.locator('[aria-label="Last page"]')).toBeVisible();
    await expect(pager.locator(".ops-paginator__page")).toHaveCount(3);

    const queriesBefore = recorder.eventListQueries.length;
    await pager.locator(".ops-paginator__page").nth(1).click();
    await expect
      .poll(() => recorder.eventListQueries.length)
      .toBeGreaterThan(queriesBefore);

    const second = recorder.eventListQueries.at(-1)!;
    expect(second.get("offset")).toBe("50");
    expect(second.get("limit")).toBe("50");

    // Last page: offset lands on the final slice, not past the end.
    await pager.locator('[aria-label="Last page"]').click();
    await expect
      .poll(() => recorder.eventListQueries.at(-1)?.get("offset"))
      .toBe("100");
  });

  test("changes the page size and keeps the record you were looking at", async ({
    page,
  }) => {
    const recorder = await mockEventStoreApi(page, { events: manyEvents });
    await page.goto("/events");
    await page.locator("tbody tr").first().waitFor();

    const pager = page.locator(".ops-pagination");
    // Move off page one first: changing the size while deep in a list is the
    // case where "keep the offset" quietly shows the wrong records.
    await pager.locator(".ops-paginator__page").nth(2).click();
    await expect
      .poll(() => recorder.eventListQueries.at(-1)?.get("offset"))
      .toBe("100");

    await pager.locator(".ops-paginator__size").click();
    await page.locator(".p-select-option").filter({ hasText: /^10$/ }).click();

    await expect
      .poll(() => recorder.eventListQueries.at(-1)?.get("limit"))
      .toBe("10");
    // 100 rows in is past the end of a 10-row page-one; the paginator recomputes
    // `first`, and the component takes it from the event rather than deriving it.
    const after = recorder.eventListQueries.at(-1)!;
    expect(Number(after.get("offset"))).toBeLessThanOrEqual(110);
    expect(Number(after.get("offset")) % 10).toBe(0);
  });
});

/**
 * The DLQ list carries the identical pager, so it gets the identical guard.
 *
 * Both pages were changed in one edit, and "the same change was applied" is not
 * evidence that it works twice — the events suite passing says nothing about
 * this one.
 */
test.describe("dlq pagination", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("pages the DLQ list the same way", async ({ page }) => {
    const recorder = await mockEventStoreApi(page, {
      dlq: makeDlqRecords(120),
    });
    await page.goto("/dlq");
    await page.locator("tbody tr").first().waitFor();

    const pager = page.locator(".ops-pagination");
    await expect(pager.locator('[aria-label="First page"]')).toBeVisible();
    await expect(pager.locator(".ops-paginator__page")).toHaveCount(3);

    await pager.locator(".ops-paginator__page").nth(1).click();
    await expect
      .poll(() => recorder.dlqListQueries.at(-1)?.get("offset"))
      .toBe("50");
  });
});

/**
 * What the links say, not just that there are links.
 *
 * PrimeNG's paginator was replaced because its links are a sliding window: on a
 * 15-page list it offered "1 2 3 4 5" and no way to know 15 existed — "showing
 * 5 continuous pages, that's not good UI/UX" (dathq, 2026-09-19). The
 * replacement always shows the first and last page with a gap for each skipped
 * run, so the control is a fixed width and the end is always one click away.
 */
test.describe("page links", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("always shows the first and last page, with gaps between runs", async ({
    page,
  }) => {
    await mockEventStoreApi(page, { events: manyEvents });
    await page.goto("/events");
    await page.locator("tbody tr").first().waitFor();

    const pager = page.locator(".ops-pagination");
    // 120 records at 10 a page is 12 pages — enough to need a gap.
    await pager.locator(".ops-paginator__size").click();
    await page.locator(".p-select-option").filter({ hasText: /^10$/ }).click();
    await expect(pager.locator(".ops-paginator__gap")).toHaveCount(1);

    const readLinks = () =>
      pager.locator(".ops-paginator__pages li").allTextContents();

    // On page 1: a run from the start, a gap, then the last page.
    expect((await readLinks()).map((s) => s.trim())).toEqual([
      "1",
      "2",
      "3",
      "4",
      "…",
      "12",
    ]);

    // In the middle: the last page is still there, and so is the first.
    await pager
      .locator(".ops-paginator__page")
      .filter({ hasText: "4" })
      .click();
    await expect
      .poll(async () => (await readLinks()).map((s) => s.trim()).at(-1))
      .toBe("12");
    const middle = (await readLinks()).map((s) => s.trim());
    expect(middle[0]).toBe("1");
    expect(middle).toContain("…");

    // The current page is a state, not a link you press again.
    await expect(pager.locator(".ops-paginator__page.is-current")).toHaveCount(
      1,
    );
  });
});

/**
 * On a phone the numbers do not fit, so they are replaced rather than clipped.
 *
 * Keyed on the **container**, not the viewport: this pager sits inside a card
 * that may itself be beside the shell's 224px sidebar.
 */
test.describe("page links on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("swaps the numbers for a readout and keeps every step reachable", async ({
    page,
  }) => {
    await mockEventStoreApi(page, { events: manyEvents });
    await page.goto("/events");
    await page.locator("tbody tr").first().waitFor();

    const pager = page.locator(".ops-pagination");
    await expect(pager.locator(".ops-paginator__pages")).toBeHidden();
    await expect(pager.locator(".ops-paginator__compact")).toBeVisible();

    // The last-page button was being clipped off the right edge; assert the
    // rect, because a clipped button is still "visible" to a selector.
    const box = await pager.boundingBox();
    const last = await pager.locator('[aria-label="Last page"]').boundingBox();
    expect(last).not.toBeNull();
    expect(last!.x + last!.width).toBeLessThanOrEqual(box!.x + box!.width + 1);
  });
});

/**
 * A total the service refused to count exactly.
 *
 * `COUNT(*)` reads every matching row, so an ops list opened unfiltered gets
 * slower forever as the store grows. The service counts a capped subquery
 * instead — at most `LIST_COUNT_CAP + 1` rows, whatever the table holds — and
 * says so, because a number that is silently a floor is worse than no number.
 *
 * Deep paging stops at the cap on purpose: `OFFSET` past it costs exactly what
 * the cap exists to avoid.
 */
test.describe("a capped total", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("marks the count as a floor and numbers only what it counted", async ({
    page,
  }) => {
    // 120 rows behind a cap of 100: the service would report 100, capped.
    await mockEventStoreApi(page, { events: manyEvents, countCap: 100 });
    await page.goto("/events");
    await expect(page.locator("tbody tr")).toHaveCount(50);

    await expect(page.locator(".events-pagination-meta")).toHaveText(
      "Showing 1–50 of 100+",
    );

    // 100 capped / 50 a page = two numbered pages, and no third link even
    // though 120 rows exist — a number you cannot compute is a number you do
    // not show. The "+" is what says the last page is not the last, and the
    // cursor is what gets you past it (below).
    await expect(page.locator(".ops-paginator__page")).toHaveText(["1", "2"]);
    await expect(page.locator(".ops-paginator__compact")).toHaveText("1 / 2+");
  });

  test("reports an exact total when the count came in under the cap", async ({
    page,
  }) => {
    await mockEventStoreApi(page, { events: manyEvents, countCap: 1000 });
    await page.goto("/events");
    await expect(page.locator("tbody tr")).toHaveCount(50);

    await expect(page.locator(".events-pagination-meta")).toHaveText(
      "Showing 1–50 of 120",
    );
    await expect(page.locator(".ops-paginator__compact")).toHaveText("1 / 3");
  });
});

/**
 * Past the last page it can count, the list keeps walking.
 *
 * This is the half that makes the cap honest. Numbered pages need a total;
 * a total needs a count; a count is what the cap refuses to finish. Stopping
 * there would strand someone at page 200 with rows still below them — strictly
 * worse than the Previous/Next this paginator replaced, which at least kept
 * going. So the numbers cover what was counted and a keyset cursor takes over
 * after that: constant cost per page, no total, no page to jump to.
 */
test.describe("paging past the cap", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("hands over to a cursor, and hands back", async ({ page }) => {
    const recorder = await mockEventStoreApi(page, {
      events: manyEvents,
      countCap: 100,
    });
    await page.goto("/events");
    await expect(page.locator("tbody tr")).toHaveCount(50);

    // The last page the service could count.
    await page.locator(".ops-paginator__page", { hasText: "2" }).click();
    await expect.poll(() => recorder.eventListQueries.length).toBe(2);

    const next = page.getByRole("button", { name: "Next page" });
    // Not disabled, which is the whole point: there is more, it just has no
    // page number.
    await expect(next).toBeEnabled();
    await next.click();

    await expect.poll(() => recorder.eventListQueries.length).toBe(3);
    const cursorQuery = lastQuery(recorder.eventListQueries);
    expect(cursorQuery.get("after")).toBeTruthy();
    // A cursor replaces the offset rather than joining it — sending both is how
    // you get a page that silently skips 100 rows.
    expect(cursorQuery.get("offset")).toBeNull();

    // 120 rows, 100 walked: the tail is 20.
    await expect(page.locator("tbody tr")).toHaveCount(20);
    await expect(page.locator(".events-pagination-meta")).toHaveText("Page 3");
    // No numbers and no "last page" button, because neither exists out here.
    await expect(page.locator(".ops-paginator__page")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Last page" })).toHaveCount(
      0,
    );
    await expect(next).toBeDisabled();

    // Back the way we came: the stack empties and the numbers return.
    await page.getByRole("button", { name: "Previous page" }).click();
    await expect.poll(() => recorder.eventListQueries.length).toBe(4);
    expect(lastQuery(recorder.eventListQueries).get("after")).toBeNull();
    await expect(page.locator("tbody tr")).toHaveCount(50);
    await expect(page.locator(".ops-paginator__page")).toHaveText(["1", "2"]);
  });
});

/**
 * A capped total must not leave dead controls behind it.
 *
 * Two defects from keying the hand-over on `totalCapped` alone (reported on
 * !207, both confirmed against the code):
 *
 * 1. **Last stayed enabled on the last numbered page.** It shared `isLast()`
 *    with Next, and on a capped list that is deliberately false there because
 *    the cursor takes over — but Last has nowhere left to jump to. It did not
 *    re-fetch (`goToPage` returns early when the target is the current page);
 *    it was simply an enabled button that did nothing, which is worse than a
 *    disabled one because it says the opposite.
 * 2. **The DLQ list showed an enabled Next that emitted into nothing.** It is
 *    capped but has no cursor paging, so it binds neither `hasNextCursor` nor
 *    `(cursorMove)`. The press fired an output nobody had subscribed to.
 *
 * `hasNextCursor` is now the precondition for the crossing, which is the only
 * honest one: no cursor issued, no hand-over offered.
 */
test.describe("a capped total leaves no dead controls", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("disables Last once you are on the last numbered page", async ({
    page,
  }) => {
    await mockEventStoreApi(page, { events: manyEvents, countCap: 100 });
    await page.goto("/events");
    await expect(page.locator("tbody tr")).toHaveCount(50);

    const last = page.getByRole("button", { name: "Last page" });
    await expect(last).toBeEnabled();

    await last.click();
    await expect(page.locator(".ops-paginator__page.is-current")).toHaveText(
      "2",
    );
    // Nowhere left to jump to, even though Next can still cross to the cursor.
    await expect(last).toBeDisabled();
    await expect(page.getByRole("button", { name: "Next page" })).toBeEnabled();
  });

  test("disables Next on a capped list that has no cursor paging", async ({
    page,
  }) => {
    const manyRecords = makeDlqRecords(120);
    const recorder = await mockEventStoreApi(page, {
      dlq: manyRecords,
      countCap: 100,
    });
    await page.goto("/dlq");
    await expect(page.locator("tbody tr")).toHaveCount(50);

    await page.getByRole("button", { name: "Last page" }).click();
    await expect(page.locator(".ops-paginator__page.is-current")).toHaveText(
      "2",
    );

    const before = recorder.dlqListQueries.length;
    // Disabled, not merely inert: the DLQ list cannot follow a cursor, so
    // offering the press would be a button that looks alive and is not.
    await expect(
      page.getByRole("button", { name: "Next page" }),
    ).toBeDisabled();
    expect(recorder.dlqListQueries.length).toBe(before);
  });
});
