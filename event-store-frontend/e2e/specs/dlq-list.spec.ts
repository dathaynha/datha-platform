import {
  DLQ_FIXTURES,
  makeDlqRecords,
  mockEventStoreApi,
} from "../event-store-api-mock";
import { authedTest as test, expect } from "../fixtures";

/** DLQ list: rendering, replayed/pending status, filters, paging, failures. */

const lastQuery = (queries: URLSearchParams[]) => queries[queries.length - 1];

test("renders each record with its sink and replay status", async ({
  page,
}) => {
  const recorder = await mockEventStoreApi(page);
  await page.goto("/dlq");

  await expect(page.locator("tbody tr")).toHaveCount(DLQ_FIXTURES.length);
  await expect(
    page.getByRole("cell", { name: "file.conversation_cleanup" }),
  ).toBeVisible();
  await expect(
    page.getByRole("cell", { name: /blob delete timed out/ }),
  ).toBeVisible();
  // One fixture carries replayedAt, the other two do not.
  await expect(page.getByText("Replayed", { exact: true })).toHaveCount(1);
  await expect(page.getByText("Pending", { exact: true })).toHaveCount(2);
  expect(recorder.unmocked).toEqual([]);
});

test("sink filter reaches the service as a repeated query param", async ({
  page,
}) => {
  const recorder = await mockEventStoreApi(page);
  await page.goto("/dlq");
  await expect(page.locator("tbody tr")).toHaveCount(DLQ_FIXTURES.length);

  await page.locator("p-multiselect").click();
  await page.getByRole("option", { name: "event_store.ingest" }).click();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Search" }).click();

  await expect.poll(() => recorder.dlqListQueries.length).toBeGreaterThan(1);
  expect(lastQuery(recorder.dlqListQueries).getAll("sink")).toEqual([
    "event_store.ingest",
  ]);
});

/**
 * Same as the events list: the sinks offered are the sinks that exist.
 *
 * The constant here was wrong in both directions — it listed two sinks with no
 * records and omitted the only one that had any, so every choice it offered
 * returned an empty table. The fixture below uses a sink that constant never
 * knew about, which is what makes this fail against it.
 */
test("sink filter offers exactly the sinks present in the data", async ({
  page,
}) => {
  const recorder = await mockEventStoreApi(page, {
    dlq: [{ ...DLQ_FIXTURES[0], sink: "messenger_service.calls" }],
  });
  await page.goto("/dlq");
  await expect(page.locator("tbody tr")).toHaveCount(1);

  await page.locator("p-multiselect").click();
  await expect(page.getByRole("option")).toHaveText([
    "messenger_service.calls",
  ]);
  expect(recorder.unmocked).toEqual([]);
});

test("correlation id filter is sent as correlation_id", async ({ page }) => {
  const recorder = await mockEventStoreApi(page);
  await page.goto("/dlq");

  await page.getByLabel("Correlation ID", { exact: true }).fill("corr-ccc");
  await page.getByRole("button", { name: "Search" }).click();

  await expect
    .poll(() => lastQuery(recorder.dlqListQueries).get("correlation_id"))
    .toBe("corr-ccc");
});

test("pagination walks the offset", async ({ page }) => {
  const recorder = await mockEventStoreApi(page, { dlq: makeDlqRecords(60) });
  await page.goto("/dlq");

  await expect(page.getByText("Showing 1–50 of 60")).toBeVisible();
  await page.getByRole("button", { name: "Next" }).click();

  await expect(page.getByText("Showing 51–60 of 60")).toBeVisible();
  await expect(page.locator("tbody tr")).toHaveCount(10);
  expect(lastQuery(recorder.dlqListQueries).get("offset")).toBe("50");
});

test("an empty DLQ shows the reassuring unfiltered copy", async ({ page }) => {
  await mockEventStoreApi(page, { dlq: [] });
  await page.goto("/dlq");

  await expect(page.getByText("No DLQ records yet")).toBeVisible();
  await expect(
    page.getByText(/Records appear here after a consumer exhausts retries/),
  ).toBeVisible();
});

test("a failing list surfaces the error banner", async ({ page }) => {
  await mockEventStoreApi(page, { dlqListError: { status: 503 } });
  await page.goto("/dlq");

  const banner = page.getByRole("alert");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("Could not load DLQ records");
  await expect(page.getByText("No DLQ records yet")).toBeHidden();
});
