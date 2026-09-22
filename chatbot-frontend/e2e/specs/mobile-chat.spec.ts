import { authedTest as test, expect } from "../fixtures";
import { mockChatApi } from "../chat-api-mock";

/**
 * The chat page on a phone.
 *
 * Measured 2026-09-17: the two panes shared a 390px viewport, so the stage was
 * left with ~110px — the empty state wrapped to one word per line and was
 * clipped mid-word. Nothing overflowed the document, so the responsiveness
 * check that looks like a responsiveness check (`scrollWidth - clientWidth`)
 * read 0 the whole time. Hence rects here, not selectors.
 */

const PHONE = { width: 390, height: 844 };
/** A phone, and — the part the hit-area test needs — a finger, not a mouse. */
const TOUCH_PHONE = { viewport: PHONE, hasTouch: true, isMobile: true };
const DESKTOP = { width: 1280, height: 800 };

/** Apple's HIG minimum; Material says 48. Asserted against the smaller one. */
const MIN_TOUCH_TARGET = 44;

/**
 * `toBeHidden()` is satisfied by an element that is not attached, so every
 * hidden-assertion below waits for the page to exist first — otherwise it
 * passes on a blank page and therefore passes against the bug.
 */
const renderedChat = async (page: import("@playwright/test").Page) => {
  await page.goto("/chat");
  await page.locator(".chat-stage").waitFor();
};

test.describe("chat page on a phone", () => {
  test.use(TOUCH_PHONE);

  test("gives the whole screen to the chat, not to the history pane", async ({
    page,
  }) => {
    await mockChatApi(page);
    await renderedChat(page);

    const stage = await page.locator(".chat-stage").boundingBox();
    expect(stage).not.toBeNull();
    expect(stage!.width).toBe(PHONE.width);

    await expect(page.locator(".chat-sidebar")).toHaveCount(1);
    await expect(page.locator(".chat-sidebar")).toBeHidden();

    // The composer is the point of the page; at 110px it was a sliver.
    const composer = await page.locator(".chat-composer").boundingBox();
    expect(composer).not.toBeNull();
    expect(composer!.width).toBeGreaterThan(300);
  });

  test("swaps to history and back", async ({ page }) => {
    await mockChatApi(page);
    await renderedChat(page);

    const open = page.getByTestId("chat-history-open");
    const box = await open.boundingBox();
    expect(box).not.toBeNull();

    // The *target* is 44px, the control is not. Drawing the whole 44 put a big
    // square beside a small word and cost the header 99px of a 490px stage at
    // 375x667 (dathq, 2026-09-21); the guideline is about what a finger can
    // hit. So the box keeps its 2rem and a transparent `::after` carries the
    // reach — which means the assertion has to read the pseudo-element, and a
    // `boundingBox()` check would now be measuring the ink.
    const reach = await open.evaluate((el) => {
      const after = getComputedStyle(el, "::after");
      return {
        width: parseFloat(after.width),
        height: parseFloat(after.height),
      };
    });
    expect(reach.width).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
    expect(reach.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
    expect(box!.height).toBeLessThan(MIN_TOUCH_TARGET);

    await open.click();

    // `boundingBox()` does not auto-wait, so it can read the frame before
    // Angular has repainted and return null for an element about to appear.
    await expect(page.locator(".chat-sidebar")).toBeVisible();
    const sidebar = await page.locator(".chat-sidebar").boundingBox();
    expect(sidebar).not.toBeNull();
    expect(sidebar!.width).toBe(PHONE.width);
    await expect(page.locator(".chat-stage")).toBeHidden();

    await page.getByTestId("chat-history-back").click();
    await expect(page.locator(".chat-stage")).toBeVisible();
    await expect(page.locator(".chat-sidebar")).toBeHidden();
  });

  test("returns to the chat when a thread is picked", async ({ page }) => {
    await mockChatApi(page);
    await renderedChat(page);

    await page.getByTestId("chat-history-open").click();
    await expect(page.locator(".chat-sidebar")).toBeVisible();

    await page.locator(".chat-history-row button").first().click();

    // Picking a thread is a navigation, so the pane that answered the question
    // gets out of the way — including when it is the thread already open,
    // which returns early in `selectConversation`.
    await expect(page.locator(".chat-stage")).toBeVisible();
    await expect(page.locator(".chat-sidebar")).toBeHidden();
  });

  test("returns to the chat when a new one is started", async ({ page }) => {
    await mockChatApi(page);
    await renderedChat(page);

    await page.getByTestId("chat-history-open").click();
    await page.locator(".chat-sidebar-primary").click();

    await expect(page.locator(".chat-stage")).toBeVisible();
    await expect(page.locator(".chat-sidebar")).toBeHidden();
  });
});

/**
 * The header's share of a small screen.
 *
 * Measured at 375x667 (dathq, 2026-09-21, with a screenshot): a 44px toggle
 * square, the word "Chat" beside it and a full-width subtitle on its own line
 * came to **99px** of a 490px stage — a fifth of the page spent saying what
 * the sub-header and the composer's model chip already say — and left the
 * thread 204px. Rects rather than classes, because "one row" and "two rows"
 * have the same DOM.
 */
test.describe("chat header on a small screen", () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test("is one row, and spends a row's worth of height", async ({ page }) => {
    await mockChatApi(page);
    await renderedChat(page);

    const header = await page.locator(".chat-header").boundingBox();
    expect(header).not.toBeNull();
    expect(header!.height).toBeLessThan(64);

    // One row means the control and the title share a centre line; stacked,
    // they are 40px apart.
    const toggle = await page.getByTestId("chat-history-open").boundingBox();
    const title = await page.locator(".chat-title").boundingBox();
    expect(toggle).not.toBeNull();
    expect(title).not.toBeNull();
    const centres = Math.abs(
      toggle!.y + toggle!.height / 2 - (title!.y + title!.height / 2),
    );
    expect(centres).toBeLessThan(4);

    // Paired with a count, so an element that never rendered cannot pass as a
    // hidden one.
    await expect(page.locator(".chat-subtitle")).toHaveCount(1);
    await expect(page.locator(".chat-subtitle")).toBeHidden();

    // The thread is what the room is for.
    const thread = await page.locator(".chat-thread").boundingBox();
    expect(thread!.height).toBeGreaterThan(230);
  });

  /**
   * The composer's hints, measured the same day: 187px of the same 490px
   * stage, of which one line reminded you of a 10-file limit nobody is near
   * and another offered **Shift+Enter**, which a soft keyboard cannot produce.
   */
  test("spends its height on the control, not on hints", async ({ page }) => {
    await mockChatApi(page);
    await renderedChat(page);

    const composer = await page.locator(".chat-composer").boundingBox();
    expect(composer).not.toBeNull();
    expect(composer!.height).toBeLessThan(140);

    for (const hint of [".chat-composer-limit", ".chat-composer-hint"]) {
      await expect(page.locator(hint)).toHaveCount(1);
      await expect(page.locator(hint)).toBeHidden();
    }

    // The box you actually type in keeps its size — this is a trim, not a
    // squeeze.
    const box = await page.locator(".chat-claude-box").boundingBox();
    expect(box!.height).toBeGreaterThan(80);
  });
});

/**
 * A phone held sideways is wide and short, and the composer is what eats it.
 *
 * Measured at 667x375 hosted (dathq, 2026-09-21): a 255px stage split 52px of
 * header, **92px of thread and 111px of composer** — the control taller than
 * the conversation. 62px of the composer is the draft row and the toolbar,
 * whose height is the 2rem `+` button's own, so what came off was the card's
 * padding and gaps rather than anything you press.
 */
test.describe("chat page on a landscape phone", () => {
  test.use({ viewport: { width: 667, height: 375 } });

  test("gives the thread more room than the composer", async ({ page }) => {
    await mockChatApi(page);
    await renderedChat(page);

    const composer = await page.locator(".chat-composer").boundingBox();
    const thread = await page.locator(".chat-thread").boundingBox();
    expect(composer).not.toBeNull();
    expect(thread).not.toBeNull();

    expect(composer!.height).toBeLessThan(100);
    expect(thread!.height).toBeGreaterThan(composer!.height);

    // The controls keep their size — this is the card's padding coming off,
    // not the button you press to attach a file.
    const add = await page.locator(".chat-claude-add").boundingBox();
    expect(add!.height).toBeGreaterThanOrEqual(32);

    // And the composer still finishes inside the viewport: its ancestor
    // clips, so anything past the bottom edge is gone rather than scrolled to.
    expect(composer!.y + composer!.height).toBeLessThanOrEqual(376);
  });
});

test.describe("chat page on a desktop", () => {
  test.use({ viewport: DESKTOP });

  test("keeps both panes and hides the compact controls", async ({ page }) => {
    await mockChatApi(page);
    await renderedChat(page);

    await expect(page.locator(".chat-sidebar")).toBeVisible();
    await expect(page.locator(".chat-stage")).toBeVisible();

    await expect(page.getByTestId("chat-history-open")).toHaveCount(1);
    await expect(page.getByTestId("chat-history-open")).toBeHidden();
    await expect(page.getByTestId("chat-history-back")).toBeHidden();

    // The phone layout must not have cost the desktop its history pane.
    const sidebar = await page.locator(".chat-sidebar").boundingBox();
    expect(sidebar).not.toBeNull();
    expect(sidebar!.width).toBeGreaterThan(250);

    // …nor the subtitle and the composer hints, which are only dropped where
    // there is no room for them.
    await expect(page.locator(".chat-subtitle")).toBeVisible();
    await expect(page.locator(".chat-composer-limit")).toBeVisible();
    await expect(page.locator(".chat-composer-hint")).toBeVisible();
  });
});
