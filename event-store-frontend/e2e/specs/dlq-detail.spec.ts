import type { Page } from "@playwright/test";
import { DLQ_FIXTURES, mockEventStoreApi } from "../event-store-api-mock";
import { authedTest as test, expect } from "../fixtures";

/**
 * DLQ detail — the one page in this app that mutates platform state. Replay is
 * behind a confirmation dialog and maps each backend status to its own message,
 * so every branch is asserted through the recorder (did the POST happen?) as
 * well as through the DOM.
 */

const PENDING = DLQ_FIXTURES[0];
const REPLAYED = DLQ_FIXTURES[1];
const NO_ENVELOPE = DLQ_FIXTURES[2];

/** Open the confirm dialog from a pending record's detail page. */
async function openReplayConfirm(page: Page) {
  await page.getByRole("button", { name: "Replay to EVENTS" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

test("renders the record with its JetStream coordinates and envelope", async ({
  page,
}) => {
  const recorder = await mockEventStoreApi(page);
  await page.goto(`/dlq/${PENDING.id}`);

  await expect(page.getByRole("heading", { name: "DLQ record" })).toBeVisible();
  await expect(page.getByText(PENDING.originalSubject)).toBeVisible();
  await expect(page.getByText(PENDING.lastError)).toBeVisible();
  await expect(page.getByText(PENDING.jetstreamSequence)).toBeVisible();
  // Envelope is what replay republishes — it has to be inspectable.
  await expect(page.getByText(/"type": "conversation\.deleted"/)).toBeVisible();
  expect(recorder.unmocked).toEqual([]);
});

test("replay asks for confirmation before touching the backend", async ({
  page,
}) => {
  const recorder = await mockEventStoreApi(page);
  await page.goto(`/dlq/${PENDING.id}`);

  const dialog = await openReplayConfirm(page);
  await expect(dialog).toContainText("Replay DLQ message?");
  await expect(dialog).toContainText(PENDING.originalSubject);
  // Nothing may be republished while the dialog is merely open.
  expect(recorder.replayedIds).toEqual([]);
});

test("cancelling the dialog does not replay", async ({ page }) => {
  const recorder = await mockEventStoreApi(page);
  await page.goto(`/dlq/${PENDING.id}`);

  const dialog = await openReplayConfirm(page);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();

  expect(recorder.replayedIds).toEqual([]);
  await expect(
    page.getByRole("button", { name: "Replay to EVENTS" }),
  ).toBeVisible();
});

test("confirming replays and flips the record to replayed", async ({
  page,
}) => {
  const recorder = await mockEventStoreApi(page);
  await page.goto(`/dlq/${PENDING.id}`);

  const dialog = await openReplayConfirm(page);
  await dialog.getByRole("button", { name: "Confirm" }).click();

  await expect(page.getByRole("status")).toContainText("Replay accepted");
  expect(recorder.replayedIds).toEqual([PENDING.id]);
  // The button is gone: the record now carries replayedAt, so canReplay is false.
  await expect(
    page.getByRole("button", { name: "Replay to EVENTS" }),
  ).toBeHidden();
  await expect(page.getByText("Replayed", { exact: true })).toBeVisible();
});

test("an already-replayed record offers no replay button", async ({ page }) => {
  await mockEventStoreApi(page);
  await page.goto(`/dlq/${REPLAYED.id}`);

  await expect(page.getByRole("heading", { name: "DLQ record" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Replay to EVENTS" }),
  ).toBeHidden();
  await expect(page.getByText("Replayed", { exact: true })).toBeVisible();
});

test("a record without an envelope explains why replay is unavailable", async ({
  page,
}) => {
  await mockEventStoreApi(page);
  await page.goto(`/dlq/${NO_ENVELOPE.id}`);

  await expect(
    page.getByRole("button", { name: "Replay to EVENTS" }),
  ).toBeHidden();
  await expect(
    page.getByText("No envelope stored — replay is not available"),
  ).toBeVisible();
  await expect(
    page.getByText("Replay unavailable — already replayed or envelope missing"),
  ).toBeVisible();
});

test("a 409 reports the record was already replayed", async ({ page }) => {
  await mockEventStoreApi(page, { replayError: { status: 409, body: {} } });
  await page.goto(`/dlq/${PENDING.id}`);

  const dialog = await openReplayConfirm(page);
  await dialog.getByRole("button", { name: "Confirm" }).click();

  await expect(page.getByRole("alert")).toContainText(
    "This record was already replayed",
  );
});

test("a 400 reports the missing envelope", async ({ page }) => {
  await mockEventStoreApi(page, { replayError: { status: 400, body: {} } });
  await page.goto(`/dlq/${PENDING.id}`);

  const dialog = await openReplayConfirm(page);
  await dialog.getByRole("button", { name: "Confirm" }).click();

  await expect(page.getByRole("alert")).toContainText(
    "Cannot replay — no valid envelope stored",
  );
});

test("a server-supplied error message wins over the generic copy", async ({
  page,
}) => {
  await mockEventStoreApi(page, {
    replayError: { status: 500, body: { error: "JetStream publish refused" } },
  });
  await page.goto(`/dlq/${PENDING.id}`);

  const dialog = await openReplayConfirm(page);
  await dialog.getByRole("button", { name: "Confirm" }).click();

  await expect(page.getByRole("alert")).toContainText(
    "JetStream publish refused",
  );
});

test("replay failures never open the global HTTP error dialog", async ({
  page,
}) => {
  // The service sets SKIP_GLOBAL_ERROR_DIALOG for replay so the page can render
  // the failure inline — a modal over an ops action would hide the record.
  await mockEventStoreApi(page, { replayError: { status: 500, body: {} } });
  await page.goto(`/dlq/${PENDING.id}`);

  const dialog = await openReplayConfirm(page);
  await dialog.getByRole("button", { name: "Confirm" }).click();

  await expect(page.getByRole("alert")).toContainText("Replay failed");
  await expect(page.locator("datha-message-dialog")).toHaveCount(0);
});

test("a failing detail load shows the error banner", async ({ page }) => {
  await mockEventStoreApi(page, { dlqDetailError: { status: 500 } });
  await page.goto(`/dlq/${PENDING.id}`);

  await expect(page.getByRole("alert")).toContainText(
    "Could not load this record",
  );
});
