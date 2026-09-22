import { mockNotificationApi } from "../notification-api-mock";
import { authedTest as test, expect } from "../fixtures";

/**
 * Notification bell + drawer + SSE toast, fully route-mocked (no backend).
 * The stream is fulfilled once with one pushed event; afterwards the token
 * mint 401s so the client's reconnect backoff idles and counts stay stable.
 */

test("SSE push raises a toast and bumps the bell badge", async ({ page }) => {
  // unreadCount 2 = the server already counts the pushed row, so the badge
  // settles on 2 whichever of push-increment / resync-set lands last.
  const recorder = await mockNotificationApi(page, {
    pushEvent: true,
    unreadCount: 2,
  });
  await page.goto("/");

  await expect(page.locator(".shell-bell-badge")).toHaveText("2");
  await expect(page.getByText("Attachment cleaned up")).toBeVisible();
  expect(recorder.unmocked).toEqual([]);
});

test("bell opens the drawer on the unread tab with severity cards", async ({
  page,
}) => {
  await mockNotificationApi(page);
  await page.goto("/");

  await expect(page.locator(".shell-bell-badge")).toHaveText("1");
  await page.getByRole("button", { name: "Open notifications" }).click();

  await expect(
    page.getByRole("heading", { name: "Notifications" }),
  ).toBeVisible();
  // unread > 0 → lands on the Unread tab (attention-first)
  await expect(page.getByRole("tab", { name: /unread/i })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator(".shell-notification-card")).toHaveCount(2);
  await expect(
    page.locator(".shell-notification-card[data-severity='info']").first(),
  ).toBeVisible();
});

test("mark all read empties the unread tab and clears the badge", async ({
  page,
}) => {
  await mockNotificationApi(page);
  await page.goto("/");

  await page.getByRole("button", { name: "Open notifications" }).click();
  await page.getByRole("button", { name: "Mark all read" }).click();

  await expect(page.getByText("All caught up.")).toBeVisible();
  await expect(page.locator(".shell-bell-badge")).toHaveCount(0);
});

/**
 * The toast has to fit the phone it pops up on.
 *
 * PrimeNG sizes `.p-toast` at a flat 25rem and `position="top-right"` offsets
 * it 20px from the right, so on a 375px screen its left edge sat at **-45px**
 * and the title was clipped off the side of the display (dathq, 2026-09-21).
 * Nothing overflowed the document — `scrollWidth === clientWidth` throughout —
 * so the check that looks like a responsiveness check read clean the whole
 * time, and the existing toast spec passed because `toBeVisible()` is
 * satisfied by an element half off-screen.
 */
test.describe("the notification toast on a phone", () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test("fits the screen instead of hanging off the left edge", async ({
    page,
  }) => {
    await mockNotificationApi(page, { pushEvent: true, unreadCount: 2 });
    await page.goto("/");
    await expect(page.getByText("Attachment cleaned up")).toBeVisible();

    const toast = await page.locator(".p-toast").boundingBox();
    expect(toast).not.toBeNull();

    // A rect, not visibility: the bug was entirely about where the box is.
    expect(toast!.x).toBeGreaterThanOrEqual(0);
    expect(toast!.x + toast!.width).toBeLessThanOrEqual(375);

    // And it still uses the width it has, rather than shrinking to nothing.
    expect(toast!.width).toBeGreaterThan(280);
  });
});

test.describe("the notification toast with room", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("keeps the width it was designed at", async ({ page }) => {
    await mockNotificationApi(page, { pushEvent: true, unreadCount: 2 });
    await page.goto("/");
    await expect(page.getByText("Attachment cleaned up")).toBeVisible();

    const toast = await page.locator(".p-toast").boundingBox();
    expect(toast!.width).toBe(400);
  });
});

/**
 * The drawer header on a phone.
 *
 * Measured at 375x667 (dathq: "a little bit cramp"): the header row gets
 * 264px for a title, "Mark all read", a gear and PrimeNG's close button. The
 * label wrapped over two lines, which showed up as the button measuring
 * **56px tall against the gear's 35px** — a wrapped flex line cannot be
 * tidied, only removed. It keeps its words and drops its icon here.
 */
test.describe("the notification drawer header on a phone", () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test("fits its actions on one line", async ({ page }) => {
    await mockNotificationApi(page, { unreadCount: 2 });
    await page.goto("/");
    await page.locator(".shell-bell-badge").waitFor();
    await page
      .getByRole("button", { name: /notification/i })
      .first()
      .click();

    const markAll = page.locator(".shell-mark-all-read");
    await expect(markAll).toBeVisible();

    // Height, not width: the wrap is what "cramped" was, and a wrapped
    // button is simply taller. 44 sits between the one-line 32 and the
    // two-line 56.
    const box = await markAll.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeLessThan(44);

    // The words are the affordance and stay; only the icon goes.
    await expect(markAll).toContainText(/mark all read/i);
    await expect(markAll.locator(".p-button-icon")).toBeHidden();

    // Nothing pushed past the drawer it lives in.
    const drawer = await page.locator(".p-drawer").boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(drawer!.x + drawer!.width);
  });
});

test.describe("the notification drawer header with room", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("keeps the icon beside the label", async ({ page }) => {
    await mockNotificationApi(page, { unreadCount: 2 });
    await page.goto("/");
    await page.locator(".shell-bell-badge").waitFor();
    await page
      .getByRole("button", { name: /notification/i })
      .first()
      .click();

    const markAll = page.locator(".shell-mark-all-read");
    await expect(markAll).toBeVisible();
    await expect(markAll.locator(".p-button-icon")).toBeVisible();
  });
});
