import { authedTest as test, expect, isRemoteUp } from "../fixtures";

const CHATBOT_ENTRY = "http://localhost:4001/remoteEntry.js";
const LANDSCAPE = { width: 667, height: 375 };

/**
 * The chat page on a phone held sideways, **hosted**.
 *
 * This cannot live in `chatbot-frontend`'s own suite, because standalone at
 * :4001 the same viewport gives the page all 667px and it looks fine. Inside
 * the shell the sidebar takes 224px, and the page's `sm:` breakpoint — a
 * *viewport* query — still read 667 and laid out two desktop panes in 443px:
 * `sm:w-72` claimed a fixed 288px for the history and left the chat **117px**,
 * narrow enough that its own subtitle wrapped one word per line. The composer
 * then ran to 451px in a 375px viewport behind `overflow: hidden`, putting the
 * send controls off-screen with no scrollbar to hint at it (2026-09-18).
 *
 * The panes now collapse on a **container** query, so the rule keys on the
 * space the panes actually have rather than on the window.
 */
test.describe("hosted chatbot on a landscape phone", () => {
  test.use({ viewport: LANDSCAPE });

  test("collapses to one pane and keeps the composer on screen", async ({
    page,
  }) => {
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

    await page.goto("/chatbot/chat");

    const stage = page.locator(".chat-stage");
    await stage.waitFor({ timeout: 30_000 });

    // A rect, not a class: "two panes" and "one pane squeezed to 117px" have
    // exactly the same DOM.
    const stageBox = await stage.boundingBox();
    expect(stageBox).not.toBeNull();
    expect(stageBox!.width).toBeGreaterThan(320);

    // The history pane yields the width rather than sharing it.
    await expect(page.locator(".chat-sidebar")).toBeHidden();
    await expect(page.locator(".chat-sidebar")).toHaveCount(1);

    // Collapsing is only safe if the way back is reachable.
    await expect(page.getByTestId("chat-history-open")).toBeVisible();

    // The composer must finish inside the viewport: its ancestor clips, so
    // anything past the bottom edge is gone rather than scrolled to.
    const composer = await page.locator(".chat-composer").boundingBox();
    expect(composer).not.toBeNull();
    expect(composer!.y + composer!.height).toBeLessThanOrEqual(
      LANDSCAPE.height + 1,
    );
  });
});

const MESSENGER_ENTRY = "http://localhost:4003/remoteEntry.js";

/**
 * The same fault, third remote.
 *
 * `chats-sidebar` carries `sm:w-72`, so hosted at 667x375 the list took a fixed
 * 288px of 443px and the stage beside it measured **119px** — the chatbot
 * number to within two pixels, from the identical cause. The panes now collapse
 * on a container query keyed to `.chats-root`.
 */
test.describe("hosted messenger on a landscape phone", () => {
  test.use({ viewport: LANDSCAPE });

  test("gives the list the whole width instead of a 119px stage", async ({
    page,
  }) => {
    test.skip(
      !(await isRemoteUp(MESSENGER_ENTRY)),
      "messenger remote not running — start it for hosted coverage",
    );

    await page.route("**/api/messenger/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: [], items: [], meta: { total: 0 } }),
      }),
    );

    await page.goto("/messenger/chats");

    const sidebar = page.locator(".chats-sidebar");
    await sidebar.waitFor({ timeout: 30_000 });

    const root = await page.locator(".chats-root").boundingBox();
    const list = await sidebar.boundingBox();
    expect(root).not.toBeNull();
    expect(list).not.toBeNull();
    // The list is the pane on screen, so it gets the room — not 288 of 443.
    expect(list!.width).toBeGreaterThan(root!.width - 40);

    // "Pick a conversation" exists to fill the space beside the list. With one
    // pane there is no beside, and it was being rendered into 119px.
    await expect(page.locator(".chats-stage--empty")).toBeHidden();
    await expect(page.locator(".chats-stage--empty")).toHaveCount(1);
  });
});
