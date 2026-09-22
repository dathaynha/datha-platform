import {
  EVENT_FIXTURES,
  makeEvents,
  mockEventStoreApi,
} from "../event-store-api-mock";
import { authedTest as test, expect } from "../fixtures";

/**
 * Events list: rendering, the filter → query-param contract, paging and the
 * error/empty states. Assertions go through the recorder wherever the point is
 * "the page asked the service for the right thing".
 */

/** Query of the most recent GET /events. */
const lastQuery = (queries: URLSearchParams[]) => queries[queries.length - 1];

test("renders one row per event with type and service", async ({ page }) => {
  const recorder = await mockEventStoreApi(page);
  await page.goto("/events");

  await expect(page.locator("tbody tr")).toHaveCount(EVENT_FIXTURES.length);
  await expect(page.getByRole("cell", { name: "file.uploaded" })).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "conversation.deleted" }),
  ).toBeVisible();

  // First load asks for the default page, newest first.
  expect(lastQuery(recorder.eventListQueries).get("limit")).toBe("50");
  expect(lastQuery(recorder.eventListQueries).get("offset")).toBe("0");
  expect(lastQuery(recorder.eventListQueries).get("order")).toBe("desc");
  expect(recorder.unmocked).toEqual([]);
});

test("service filter reaches the service as a repeated query param", async ({
  page,
}) => {
  const recorder = await mockEventStoreApi(page);
  await page.goto("/events");
  await expect(page.locator("tbody tr")).toHaveCount(EVENT_FIXTURES.length);

  await page.locator("p-multiselect.events-service-filter").click();
  await page.getByRole("option", { name: "file-service" }).click();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Search" }).click();

  await expect.poll(() => recorder.eventListQueries.length).toBeGreaterThan(1);
  expect(lastQuery(recorder.eventListQueries).getAll("service")).toEqual([
    "file-service",
  ]);
});

/**
 * A refetch is announced, not merely spun at.
 *
 * PrimeNG's loading mask is a spinner whose icon is `aria-hidden`, so every
 * filter, sort and page change refetched in total silence for a screen reader.
 * `EVENTS_PAGE.LOADING_LIST` had been in both catalogs since the page was
 * written and bound to nothing — the "specified and never built" half of an
 * orphaned string, which is why it was not simply deleted.
 *
 * Asserted through the live region's text, because that is what is announced;
 * the spinner was there the whole time and proves nothing.
 */
test("announces that the list is loading", async ({ page }) => {
  await mockEventStoreApi(page);

  // Hold the second request open so the loading state is observable at all.
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  let seen = 0;
  await page.route("**/api/event-store/events?*", async (route) => {
    seen += 1;
    if (seen > 1) await held;
    await route.fallback();
  });

  await page.goto("/events");
  await expect(page.locator("tbody tr")).toHaveCount(EVENT_FIXTURES.length);

  const status = page.locator('[role="status"]');
  await expect(status).toHaveCount(1);
  await expect(status).toBeEmpty();

  await page.getByRole("button", { name: "Search" }).click();
  await expect(status).toHaveText("Loading events…");

  release();
  await expect(status).toBeEmpty();
});

/**
 * The filter's options come from the data, not from a list in the source.
 *
 * The constant they replaced had drifted badly: it offered `analytics-service`,
 * which has never published an event, and omitted `realtime-service` and
 * `messenger-service`, which between them account for 78% of the rows. Asserted
 * as the *exact* set so an extra entry fails as loudly as a missing one — an
 * option that can only ever return an empty table is the half of this bug that
 * a "contains" assertion would wave through.
 */
test("service filter offers exactly the services present in the data", async ({
  page,
}) => {
  const recorder = await mockEventStoreApi(page);
  await page.goto("/events");
  await expect(page.locator("tbody tr")).toHaveCount(EVENT_FIXTURES.length);

  await page.locator("p-multiselect.events-service-filter").click();
  const options = page.getByRole("option");
  await expect(options).toHaveText([
    "api-gateway",
    "chatbot-service",
    "file-service",
  ]);
  expect(recorder.unmocked).toEqual([]);
});

/**
 * The options panel is tall enough for the platform it describes.
 *
 * PrimeNG's default `scrollHeight` is 200px — five 40px rows, minus the list's
 * padding, so the fifth is cut in half. That was invisible while the options
 * were a constant of four, and appeared the moment they came from the data
 * (measured 2026-09-19: five publishers, the last one clipped by 14px). A
 * partial row is a fine scroll affordance when there is more below and reads as
 * broken when there is not.
 *
 * Asserted as a rect, not a class: the option existed and was reachable the
 * whole time it was being clipped.
 */
test("the service options panel shows whole rows, not a clipped one", async ({
  page,
}) => {
  const services = [
    "accounts-service",
    "api-gateway",
    "chatbot-service",
    "event-store",
    "file-service",
    "messenger-service",
    "realtime-service",
  ];
  await mockEventStoreApi(page, {
    events: services.map((service, index) => ({
      ...EVENT_FIXTURES[0],
      id: `evt-${index}`,
      service,
    })),
  });
  await page.goto("/events");
  await expect(page.locator("tbody tr")).toHaveCount(services.length);

  await page.locator("p-multiselect.events-service-filter").click();
  await expect(page.getByRole("option")).toHaveCount(services.length);

  const clipped = await page.evaluate(() => {
    const scroller = document.querySelector(
      ".p-multiselect-list-container",
    ) as HTMLElement;
    const bounds = scroller.getBoundingClientRect();
    return Array.from(document.querySelectorAll("li[role=option]")).filter(
      (option) => {
        const rect = option.getBoundingClientRect();
        return rect.bottom > bounds.bottom + 1 || rect.top < bounds.top - 1;
      },
    ).length;
  });
  expect(clipped).toBe(0);
});

/**
 * A filter that cannot load its options is still a page.
 *
 * Empty is the deliberate degradation — falling back to the old constant would
 * re-introduce the wrong list. What must survive is a filter that came from the
 * URL, because that is a bookmark someone already has.
 */
test("a failed options fetch leaves the list working and the URL filter applied", async ({
  page,
}) => {
  const recorder = await mockEventStoreApi(page, {
    serviceOptionsError: { status: 500 },
  });
  await page.goto("/events?service=file-service");

  await expect(page.locator("tbody tr")).toHaveCount(EVENT_FIXTURES.length);
  expect(lastQuery(recorder.eventListQueries).getAll("service")).toEqual([
    "file-service",
  ]);

  await page.locator("p-multiselect.events-service-filter").click();
  await expect(page.getByRole("option")).toHaveCount(0);
});

/**
 * Filtering on a field that lives inside the payload.
 *
 * `origin` was added to the file events so an audit could tell a chatbot
 * attachment from a messenger one — and was then unfilterable, because the list
 * filters columns and `origin` is in `payload`. The fix is generic rather than
 * an `origin` param: the service matches by containment over one GIN index, so
 * every payload key works and the next publisher to add a field gets it free.
 *
 * Asserted on the request, because the page's job is to ask correctly; that the
 * SQL matches a *number* as well as a string is checked against real Postgres.
 */
test("payload filter reaches the service as payload.<key>", async ({
  page,
}) => {
  const recorder = await mockEventStoreApi(page);
  await page.goto("/events");
  await expect(page.locator("tbody tr")).toHaveCount(EVENT_FIXTURES.length);

  await page.getByRole("button", { name: "More filters" }).click();
  // Both halves are menus fed by the data: a payload key is an implementation
  // detail of whichever service published the event, so it cannot be typed
  // from memory and neither can its values.
  await page.locator("#events-filter-payload-key").click();
  await page.getByRole("option", { name: "origin", exact: true }).click();
  await page.locator("p-autocomplete button").click();
  await page.getByRole("option", { name: "messenger", exact: true }).click();
  await page.getByRole("button", { name: "Search" }).click();

  await expect.poll(() => recorder.eventListQueries.length).toBeGreaterThan(1);
  expect(lastQuery(recorder.eventListQueries).get("payload.origin")).toBe(
    "messenger",
  );
  await expect(page.getByText("payload.origin: messenger")).toBeVisible();
});

/**
 * A deep link may carry several pairs, and touching the box must not lose them.
 *
 * The inputs set one key at a time; removing is the chip's job. Getting this
 * backwards would silently drop filters the URL asked for, which reads as the
 * page returning too many rows rather than as a bug.
 */
test("payload filters from the URL survive adding another", async ({
  page,
}) => {
  const recorder = await mockEventStoreApi(page);
  await page.goto(
    "/events?payload.origin=messenger&payload.mime_type=image/png",
  );
  await expect(page.locator("tbody tr")).toHaveCount(EVENT_FIXTURES.length);

  const first = lastQuery(recorder.eventListQueries);
  expect(first.get("payload.origin")).toBe("messenger");
  expect(first.get("payload.mime_type")).toBe("image/png");

  // The panel is already open: a payload filter is an advanced filter, so
  // arriving with one in the URL expands the panel that holds it.
  await expect(page.locator("#events-filter-payload-key")).toBeVisible();
  await page.locator("#events-filter-payload-key").click();
  await page.getByRole("option", { name: "mime_type", exact: true }).click();
  // Typed rather than picked, which the value control still allows — the
  // service caps its suggestion list, so a high-cardinality field will never
  // offer everything.
  await page.locator("#events-filter-payload-value").fill("image/webp");
  await page.getByRole("button", { name: "Search" }).click();

  await expect.poll(() => recorder.eventListQueries.length).toBeGreaterThan(1);
  const after = lastQuery(recorder.eventListQueries);
  expect(after.get("payload.origin")).toBe("messenger");
  expect(after.get("payload.mime_type")).toBe("image/webp");

  // And a chip takes exactly one back off. Addressed by role and name, which
  // only works because each chip now says *which* filter it removes — before
  // this they all announced "Remove filter" and were indistinguishable to a
  // screen reader and to a test.
  await page
    .getByRole("button", {
      name: "Remove filter: payload.mime_type: image/png",
    })
    .click();
  await expect.poll(() => recorder.eventListQueries.length).toBeGreaterThan(2);
  const removed = lastQuery(recorder.eventListQueries);
  expect(removed.get("payload.mime_type")).toBeNull();
  expect(removed.get("payload.origin")).toBe("messenger");
});

test("type filter sends one param per chosen type", async ({ page }) => {
  const recorder = await mockEventStoreApi(page);
  await page.goto("/events");

  await page.getByRole("button", { name: "More filters" }).click();
  await page.locator("p-multiselect.events-type-filter").click();
  // The options arrive from a fetch, so wait for the one we are about to click
  // rather than for "some option": an empty PrimeNG menu still renders a single
  // `role=option` row for its empty message, so a count check passes on it.
  await expect(
    page.getByRole("option", { name: "file.uploaded", exact: true }),
  ).toBeVisible();
  // Picked in the opposite order to the assertion below, so the sort is what
  // makes it pass rather than the order of clicking.
  await page
    .getByRole("option", { name: "file.uploaded", exact: true })
    .click();
  await page.getByRole("option", { name: "auth.login", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Search" }).click();

  await expect.poll(() => recorder.eventListQueries.length).toBeGreaterThan(1);
  // The menu writes through `typeInputFromTypes`, which sorts, so the query
  // state stays canonical and a deep link is stable regardless of pick order.
  expect(lastQuery(recorder.eventListQueries).getAll("type")).toEqual([
    "auth.login",
    "file.uploaded",
  ]);
});

// The options are fetched, not hard-coded — the same drift that had left 78% of
// events unfilterable by service. Free text hid this class of mistake: a type
// that does not exist reads as "nothing of that kind happened", not as a typo.
test("type filter offers the types the store reports", async ({ page }) => {
  await mockEventStoreApi(page);
  await page.goto("/events");

  await page.getByRole("button", { name: "More filters" }).click();
  await page.locator("p-multiselect.events-type-filter").click();

  await expect(page.getByRole("option")).toHaveCount(
    new Set(EVENT_FIXTURES.map((event) => event.type)).size,
  );
  await expect(
    page.getByRole("option", { name: "file.uploaded", exact: true }),
  ).toBeVisible();
});

test("advanced filter toggle reports its state via aria-expanded", async ({
  page,
}) => {
  await mockEventStoreApi(page);
  await page.goto("/events");

  const toggle = page.getByRole("button", { name: "More filters" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");

  await toggle.click();
  await expect(
    page.getByRole("button", { name: "Fewer filters" }),
  ).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("p-multiselect.events-type-filter")).toBeVisible();
});

test("clearing filters drops them from the next query", async ({ page }) => {
  const recorder = await mockEventStoreApi(page);
  await page.goto("/events");

  await page.getByRole("button", { name: "More filters" }).click();
  await page.getByLabel("Owner ID").fill("google_someone-else");
  await page.getByRole("button", { name: "Search" }).click();
  await expect
    .poll(() => lastQuery(recorder.eventListQueries).get("owner_id"))
    .toBe("google_someone-else");

  await page.getByRole("button", { name: "Clear" }).click();
  await expect
    .poll(() => lastQuery(recorder.eventListQueries).get("owner_id"))
    .toBeNull();
});

test("pagination walks the offset and disables Previous on page one", async ({
  page,
}) => {
  const recorder = await mockEventStoreApi(page, { events: makeEvents(60) });
  await page.goto("/events");

  await expect(page.getByText("Showing 1–50 of 60")).toBeVisible();
  await expect(page.getByRole("button", { name: "Previous" })).toBeDisabled();

  await page.getByRole("button", { name: "Next" }).click();

  await expect(page.getByText("Showing 51–60 of 60")).toBeVisible();
  await expect(page.locator("tbody tr")).toHaveCount(10);
  expect(lastQuery(recorder.eventListQueries).get("offset")).toBe("50");
  await expect(page.getByRole("button", { name: "Next" })).toBeDisabled();

  await page.getByRole("button", { name: "Previous" }).click();
  await expect(page.getByText("Showing 1–50 of 60")).toBeVisible();
  expect(lastQuery(recorder.eventListQueries).get("offset")).toBe("0");
});

test("sorting the timestamp column flips the order param", async ({ page }) => {
  const recorder = await mockEventStoreApi(page);
  await page.goto("/events");
  await expect(page.locator("tbody tr")).toHaveCount(EVENT_FIXTURES.length);

  await page.getByRole("columnheader", { name: "Timestamp" }).click();

  await expect
    .poll(() => lastQuery(recorder.eventListQueries).get("order"))
    .toBe("asc");
});

test("empty result shows the unfiltered copy, filtered shows the other", async ({
  page,
}) => {
  await mockEventStoreApi(page, { events: [] });
  await page.goto("/events");

  await expect(page.getByText("No events ingested yet")).toBeVisible();
  await expect(
    page.getByText(/Events appear here after services publish/),
  ).toBeVisible();

  await page.getByRole("button", { name: "More filters" }).click();
  await page.getByLabel("Entity ID").fill("nothing-matches-this");
  await page.getByRole("button", { name: "Search" }).click();

  await expect(page.getByText("No events match your filters")).toBeVisible();
  await expect(
    page.getByText("Try clearing filters or widening the date range."),
  ).toBeVisible();
});

test("a failing list surfaces the error banner, not an empty table", async ({
  page,
}) => {
  await mockEventStoreApi(page, { eventsListError: { status: 500 } });
  await page.goto("/events");

  const banner = page.getByRole("alert");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("Could not load events");
  // The empty-state overlay must stay away — "broken" and "empty" are
  // different answers and the ops UI has to tell them apart.
  await expect(page.getByText("No events ingested yet")).toBeHidden();
});
