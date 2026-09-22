import { EVENT_FIXTURES, mockEventStoreApi } from "../event-store-api-mock";
import { authedTest as test, expect } from "../fixtures";

/** Event detail: row → detail navigation, payload rendering, failure state. */

const EVENT = EVENT_FIXTURES[0];

test("clicking a row opens its detail with the full payload", async ({
  page,
}) => {
  const recorder = await mockEventStoreApi(page);
  await page.goto("/events");

  await page.getByRole("cell", { name: EVENT.type }).click();

  await expect(page).toHaveURL(new RegExp(`/events/${EVENT.id}$`));
  await expect(
    page.getByRole("heading", { name: "Event detail" }),
  ).toBeVisible();
  await expect(page.getByText(EVENT.id, { exact: true })).toBeVisible();
  await expect(page.getByText(EVENT.correlationId!)).toBeVisible();
  // Payload is pretty-printed, so the raw DTO string would not match.
  await expect(page.getByText(/"blobName": "invoice\.pdf"/)).toBeVisible();
  expect(recorder.unmocked).toEqual([]);
});

test("a deep link loads the record on its own", async ({ page }) => {
  await mockEventStoreApi(page);
  await page.goto(`/events/${EVENT.id}`);

  await expect(
    page.getByRole("heading", { name: "Event detail" }),
  ).toBeVisible();
  await expect(page.getByText(EVENT.type, { exact: true })).toBeVisible();
});

test("back returns to the list", async ({ page }) => {
  await mockEventStoreApi(page);
  await page.goto(`/events/${EVENT.id}`);
  await expect(
    page.getByRole("heading", { name: "Event detail" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Back to list" }).click();

  await expect(page).toHaveURL(/\/events$/);
  await expect(page.locator("tbody tr")).toHaveCount(EVENT_FIXTURES.length);
});

test("a failing detail shows the error banner", async ({ page }) => {
  await mockEventStoreApi(page, { eventDetailError: { status: 500 } });
  await page.goto(`/events/${EVENT.id}`);

  const banner = page.getByRole("alert");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("Could not load this event");
});

test("an unknown id renders the error banner, not a blank card", async ({
  page,
}) => {
  await mockEventStoreApi(page);
  await page.goto("/events/does-not-exist");

  await expect(page.getByRole("alert")).toContainText(
    "Could not load this event",
  );
});
