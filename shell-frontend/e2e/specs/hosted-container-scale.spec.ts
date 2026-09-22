import { authedTest as test, expect, isRemoteUp } from "../fixtures";

const EVENT_STORE_ENTRY = "http://localhost:4002/remoteEntry.js";

/**
 * A remote's responsive scale, measured **hosted**.
 *
 * This cannot live in `event-store-frontend`'s own suite: standalone at :4002
 * the viewport and the content are the same width, so every viewport-keyed
 * breakpoint is accidentally correct and the bug is invisible. Inside the shell
 * the sidebar takes 224px, and the two stop agreeing.
 *
 * Measured on 2026-09-20, before the migration to container queries: at a
 * 1024px window the page had 800px and still took the `lg:` gutter (48px), and
 * at 667x375 it had 443px and still took the `sm:` gutter (32px). Both are a
 * whole step too wide for the room — the error is exactly the sidebar, every
 * time. The `xl:`/`2xl:` steps were worse than wrong: no window this page is
 * shown in is 224px wider than the room it gets, so they could only ever fire
 * in the wrong condition.
 *
 * The assertions below are about the *tier* the page picks, which is the thing
 * that was broken. They deliberately do not restate the whole scale.
 */
test.describe("hosted event-store scales to its container", () => {
  test.beforeEach(async ({ page }) => {
    test.skip(
      !(await isRemoteUp(EVENT_STORE_ENTRY)),
      "event-store remote not running — start it for hosted coverage",
    );
    await page.route("**/api/event-store/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: [], meta: { total: 0, capped: false } }),
      }),
    );
  });

  // 1024 - 224 = 800, which is below the 64rem tier the window alone would pick.
  test("takes the tablet gutter in a window wide enough for the desktop one", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1024, height: 900 });
    await page.goto("/event-store/events");

    const body = page.locator(".events-page-body");
    await expect(body).toHaveCount(1);
    const box = await body.boundingBox();
    expect(box).not.toBeNull();
    // The premise of the test: the content really is narrower than the window.
    expect(box!.width).toBeLessThan(1024);

    await expect(body).toHaveCSS("padding-left", "32px");
  });

  // A landscape phone: 667 reads as a tablet, 443 is a phone's worth of room.
  test("takes the phone gutter on a landscape phone", async ({ page }) => {
    await page.setViewportSize({ width: 667, height: 375 });
    await page.goto("/event-store/events");

    const body = page.locator(".events-page-body");
    await expect(body).toHaveCount(1);
    const box = await body.boundingBox();
    expect(box!.width).toBeLessThan(500);

    await expect(body).toHaveCSS("padding-left", "20px");
  });

  // The landing page carried `xl:` and `2xl:` steps that the shell's own
  // chrome makes unreachable-but-still-firing; the title is the loudest of them.
  test("sizes the landing title from the column, not the window", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/event-store");

    const title = page.locator(".landing-title");
    await expect(title).toHaveCount(1);
    // 1280 - 224 = 1056: below the 80rem tier, so `text-6xl` and not `text-7xl`.
    await expect(title).toHaveCSS("font-size", "60px");
  });
});

const CHATBOT_ENTRY = "http://localhost:4001/remoteEntry.js";

/**
 * The same measurement, second remote.
 *
 * `chatbot-frontend` carried 64 viewport utilities across its two routes, and
 * hosted every tier fired exactly one step too early (measured 2026-09-21):
 * 443px of room took the 640px tier at 667x375, 610px took it at 834x1112,
 * 1056px took the 1280px tier and 1312px took the 1536px one — four of five
 * viewports wrong, always by the width of the shell's sidebar.
 *
 * The chat page was the sharper case, because it was *half* migrated: its
 * panes had keyed on a container since 2026-09-18 while its gutters still
 * keyed on the window, so at 834x1112 hosted the page collapsed to one pane
 * (610px of room) and took the `sm:` gutter off the 834px window in the same
 * frame.
 */
test.describe("hosted chatbot scales to its container", () => {
  test.beforeEach(async ({ page }) => {
    test.skip(
      !(await isRemoteUp(CHATBOT_ENTRY)),
      "chatbot remote not running — start it for hosted coverage",
    );
    await page.route("**/api/chatbot/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: [], items: [], meta: { total: 0 } }),
      }),
    );
  });

  // 834 - 224 = 610, which is below the 40rem tier the window alone would pick.
  test("takes the phone gutter in a window wide enough for the tablet one", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 834, height: 1112 });
    await page.goto("/chatbot");

    const body = page.locator(".landing-body");
    await expect(body).toHaveCount(1);
    const box = await body.boundingBox();
    expect(box).not.toBeNull();
    // The premise of the test: the content really is narrower than the window.
    expect(box!.width).toBeLessThan(640);

    await expect(body).toHaveCSS("padding-left", "20px");
  });

  // 1280 - 224 = 1056: the `lg` tier, not the `xl` one the window would pick.
  test("sizes the landing title from the column, not the window", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/chatbot");

    const title = page.locator(".landing-title");
    await expect(title).toHaveCount(1);
    await expect(title).toHaveCSS("font-size", "60px");
    await expect(page.locator(".landing-body")).toHaveCSS(
      "padding-left",
      "48px",
    );
  });

  // 1536 - 224 = 1312. `2xl` could never be right here: no window this page is
  // shown in is 224px wider than the room it gets.
  test("never reaches the widest tier the window offers", async ({ page }) => {
    await page.setViewportSize({ width: 1536, height: 960 });
    await page.goto("/chatbot");

    await expect(page.locator(".landing-body")).toHaveCSS(
      "padding-left",
      "64px",
    );
  });

  // The half-migrated case: one pane and a two-pane gutter, in one frame.
  test("collapses the panes and narrows the gutters at the same width", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 834, height: 1112 });
    await page.goto("/chatbot/chat");

    const stage = page.locator(".chat-stage");
    await stage.waitFor({ timeout: 30_000 });

    // Pane state and gutter state have to agree — that they disagreed is the
    // whole finding, and each half looks correct on its own.
    await expect(page.locator(".chat-sidebar")).toHaveCount(1);
    await expect(page.locator(".chat-sidebar")).toBeHidden();
    await expect(page.locator(".chat-header")).toHaveCSS(
      "padding-left",
      "20px",
    );
  });
});

const MESSENGER_ENTRY = "http://localhost:4003/remoteEntry.js";

/**
 * The same measurement, third and last remote.
 *
 * `messenger-frontend`'s chats page had keyed on a container since !203, but
 * its landing page had not, and hosted every tier fired one step too early
 * (measured 2026-09-21): 443px of room took the 640px tier at 667x375, 610px
 * took it at 834x1112 and 1056px took the 1280px tier.
 *
 * The chats page had a subtler version of the same split: the panes collapsed
 * on a container query while `.chats-root`'s own `sm:gap-3 sm:p-3` still came
 * off the window, so at 443px of room the page gave up its second pane and
 * kept the two-pane padding.
 */
test.describe("hosted messenger scales to its container", () => {
  test.beforeEach(async ({ page }) => {
    test.skip(
      !(await isRemoteUp(MESSENGER_ENTRY)),
      "messenger remote not running — start it for hosted coverage",
    );
    await page.route("**/api/messenger/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: [],
          items: [],
          conversations: [],
          messages: [],
          meta: { total: 0 },
        }),
      }),
    );
  });

  // 834 - 224 = 610, which is below the 40rem tier the window alone would pick.
  test("takes the phone tier in a window wide enough for the tablet one", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 834, height: 1112 });
    await page.goto("/messenger");

    const title = page.locator(".landing-title");
    await expect(title).toHaveCount(1);
    await expect(title).toHaveCSS("font-size", "36px");

    const body = page.locator(".landing-body");
    const box = await body.boundingBox();
    // The premise of the test: the content really is narrower than the window.
    expect(box!.width).toBeLessThan(640);
    await expect(body).toHaveCSS("padding-left", "20px");
  });

  // 1280 - 224 = 1056: the `lg` tier, not the `xl` one the window would pick.
  test("sizes the landing title from the column, not the window", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/messenger");

    await expect(page.locator(".landing-title")).toHaveCSS("font-size", "60px");
  });

  // The chats page gave up its second pane and kept the two-pane padding.
  test("drops the pane padding at the width it drops the pane", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 667, height: 375 });
    await page.goto("/messenger/chats");

    const root = page.locator(".chats-root");
    await root.waitFor({ timeout: 30_000 });
    await expect(root).toHaveCSS("padding", "0px");

    // One pane, and it owns the whole width rather than 288px of it.
    const rootBox = await root.boundingBox();
    const sidebar = await page.locator(".chats-sidebar").boundingBox();
    expect(sidebar!.width).toBe(rootBox!.width);
  });
});
