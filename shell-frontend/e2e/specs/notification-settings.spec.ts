import { mockNotificationApi } from "../notification-api-mock";
import { authedTest as test, expect } from "../fixtures";

/** /settings/notifications — preferences page, fully route-mocked. */

test("settings page loads defaults and saves a toggled preference", async ({
  page,
}) => {
  const { putBodies } = await mockNotificationApi(page);
  await page.goto("/settings/notifications");

  await expect(
    page.getByRole("heading", { name: "Notification settings" }),
  ).toBeVisible();

  // severity row hidden while push is off
  await expect(page.getByText("Minimum severity")).toBeHidden();

  // Email digest toggle saves straight through — push needs a real browser
  // permission grant first (covered below), so it can't drive the PUT here.
  await page.locator("p-toggleswitch").last().click();

  await expect
    .poll(() => putBodies.length, { message: "PUT should fire" })
    .toBeGreaterThan(0);
  expect(putBodies[0]).toEqual(expect.objectContaining({ emailDigest: true }));
});

test("push toggle without browser permission shows the blocked notice and does not save", async ({
  page,
}) => {
  const { putBodies } = await mockNotificationApi(page);
  await page.goto("/settings/notifications");
  await expect(
    page.getByRole("heading", { name: "Notification settings" }),
  ).toBeVisible();

  await page.locator("p-toggleswitch").first().click();

  // headless denies permission → per-reason notice, no preference persisted
  await expect(
    page
      .locator(".shell-drawer-error")
      .filter({ hasText: /notifications|blocked|dismissed/i }),
  ).toBeVisible();
  expect(putBodies.length).toBe(0);
});

test("severity dropdown opens its overlay and saves the picked floor", async ({
  page,
}) => {
  // Push already enabled — the severity row is only rendered then.
  const { putBodies } = await mockNotificationApi(page, {
    preferences: { pushEnabled: true },
  });

  await page.goto("/settings/notifications");
  await expect(page.getByText("Minimum severity")).toBeVisible();

  // Overlay is briefly held invisible while PrimeNG positions it (glass-safe
  // enter animation, base.scss) — options must still become clickable.
  await page.locator("shell-notification-preferences-page p-select").click();
  await page.getByRole("option", { name: "Warning" }).click();

  await expect
    .poll(() => putBodies.length, { message: "PUT should fire" })
    .toBeGreaterThan(0);
  expect(putBodies[0]).toEqual(
    expect.objectContaining({ pushMinSeverity: "warning" }),
  );
});

test("settings hub lists sections and navigates to notifications", async ({
  page,
}) => {
  await mockNotificationApi(page);
  await page.goto("/settings");

  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  // Appearance and Language are no longer disabled placeholders: they settle
  // their one preference inline, because below `sm` the toolbar drops both
  // selects and this page becomes the only way to reach them.
  await expect(
    page.getByTestId("settings-theme").locator("datha-theme-select"),
  ).toBeVisible();
  await expect(
    page.getByTestId("settings-lang").locator("datha-lang-select"),
  ).toBeVisible();

  // Exact: the bell trigger is also named "Open notifications".
  await page
    .getByRole("button", { name: "Notifications", exact: true })
    .click();
  await expect(page).toHaveURL(/\/settings\/notifications/);
  await expect(
    page.getByRole("heading", { name: "Notification settings" }),
  ).toBeVisible();
});

/**
 * The preference cards host a control, and a glass card cannot.
 *
 * `.datha-glass-sheen` sets `overflow: hidden` to clip its `::before` to the
 * card's radius. PrimeNG renders a select's overlay **inline**, so inside such
 * a card the panel was cut off at the card's edge and, being in flow, was tall
 * enough to push the card's own icon out through the top — content measured
 * 361px inside a 260px box, icon at y=279 against a card top of y=294
 * (reported by dathq with a screenshot, 2026-09-17).
 */
test("the appearance card opens its dropdown without clipping itself", async ({
  page,
}) => {
  await mockNotificationApi(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/settings");

  const card = page.getByTestId("settings-theme");
  await expect(card).toBeVisible();
  await card.locator("datha-theme-select button").first().click();

  const panel = page.locator(".p-popover");
  await expect(panel).toBeVisible();

  const cardBox = (await card.boundingBox())!;
  const iconBox = (await card
    .locator(".shell-glass-card__icon")
    .boundingBox())!;
  const panelBox = (await panel.boundingBox())!;

  // The card does not clip its own contents upward.
  expect(iconBox.y).toBeGreaterThanOrEqual(cardBox.y);

  // The panel escapes the card rather than being cut off at its edge, and
  // both options are reachable inside the viewport.
  expect(panelBox.y + panelBox.height).toBeGreaterThan(
    cardBox.y + cardBox.height,
  );
  expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(800);
  await expect(panel.getByRole("button", { name: /midnight/i })).toBeVisible();
});

test("drawer gear navigates to the settings page", async ({ page }) => {
  await mockNotificationApi(page, { notifications: [], unreadCount: 0 });

  await page.goto("/");
  await page.getByRole("button", { name: "Open notifications" }).click();
  await page.getByRole("button", { name: "Notification settings" }).click();

  await expect(page).toHaveURL(/\/settings\/notifications/);
  await expect(
    page.getByRole("heading", { name: "Notification settings" }),
  ).toBeVisible();
});

/**
 * The severity row on a phone.
 *
 * Measured at 375x667 on 2026-09-21 (dathq: "looks cramp"): the nested row's
 * 3.5rem indent plus a fixed 11rem select left the label **79px**, wrapping
 * the heading over two lines and the hint over four — and the row's right
 * edge landed at **384px** against a card ending at 343 and a viewport of
 * 375. The card sets `overflow: hidden` for its sheen, so the select was not
 * merely cramped but **cut off**, and with nothing overflowing the document
 * no scrollbar appeared to say so.
 */
test.describe("notification settings on a phone", () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test("keeps the severity control inside the card", async ({ page }) => {
    await mockNotificationApi(page, {
      unreadCount: 0,
      preferences: { pushEnabled: true },
    });
    await page.goto("/settings/notifications");
    await page.locator(".settings-row--nested").waitFor();

    const card = await page.locator(".shell-glass-card").first().boundingBox();
    const row = await page.locator(".settings-row--nested").boundingBox();
    const select = await page
      .locator(".settings-severity-select")
      .boundingBox();
    expect(card).not.toBeNull();
    expect(row).not.toBeNull();
    expect(select).not.toBeNull();

    // The assertion the bug failed: the card clips, so past its edge is gone.
    expect(row!.x + row!.width).toBeLessThanOrEqual(card!.x + card!.width + 1);
    expect(select!.x + select!.width).toBeLessThanOrEqual(375);

    // Stacked, so the label gets the whole row rather than 79px of it.
    const heading = await page
      .locator(".settings-row--nested h3")
      .boundingBox();
    expect(heading!.width).toBeGreaterThan(200);
    expect(select!.y).toBeGreaterThan(heading!.y + heading!.height);
  });
});

test.describe("notification settings with room", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("keeps the control beside its label", async ({ page }) => {
    await mockNotificationApi(page, {
      unreadCount: 0,
      preferences: { pushEnabled: true },
    });
    await page.goto("/settings/notifications");
    await page.locator(".settings-row--nested").waitFor();

    const heading = await page
      .locator(".settings-row--nested h3")
      .boundingBox();
    const select = await page
      .locator(".settings-severity-select")
      .boundingBox();
    // Side by side: the select starts to the right of the label, not below.
    expect(select!.x).toBeGreaterThan(heading!.x + heading!.width);
  });
});
