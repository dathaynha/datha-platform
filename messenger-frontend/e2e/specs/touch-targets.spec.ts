import { authedTest as test, expect } from "../fixtures";
import { conversation, message, mockBackend } from "../mock-backend";

/**
 * Touch targets in the thread.
 *
 * Measured 2026-09-17: the header's call, video and back buttons were 32x32
 * and the composer's send and attach 40x40, against the 44px minimum Apple's
 * HIG sets and Material raises to 48. Nothing was broken — every one of them
 * was visible, correct and hard to hit, which no existing assertion could see.
 */

const MIN_TOUCH_TARGET = 44;

/** A phone, and — the part that matters — a finger rather than a mouse. */
const TOUCH_PHONE = {
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
};

test.describe("thread controls under a finger", () => {
  test.use(TOUCH_PHONE);

  test("are a finger wide to hit, without being a finger wide to look at", async ({
    page,
  }) => {
    await mockBackend(page, {
      conversations: [conversation()],
      messages: [message()],
    });
    await page.goto("/chats/c1");
    await page.getByTestId("composer-input").waitFor();

    // The *target* is 44px, the control is not. Drawing the whole 44 made a
    // thread header of three big squares beside the avatar and the name, which
    // is not what the guideline asks for — it is about what a finger can hit.
    // So the box keeps its size and a transparent `::after` carries the reach.
    for (const [name, locator] of [
      ["thread-back", page.locator(".thread-back")],
      ["thread-call", page.getByTestId("thread-call")],
      ["thread-call-video", page.getByTestId("thread-call-video")],
      ["composer-send", page.getByTestId("composer-send")],
      ["composer-attach", page.locator(".composer-attach")],
    ] as const) {
      const box = await locator.boundingBox();
      expect(box, `${name} should be rendered`).not.toBeNull();

      const hit = await locator.evaluate((el) => {
        const after = getComputedStyle(el, "::after");
        return {
          width: parseFloat(after.width),
          height: parseFloat(after.height),
        };
      });
      expect(hit.width, `${name} hit width`).toBeGreaterThanOrEqual(
        MIN_TOUCH_TARGET,
      );
      expect(hit.height, `${name} hit height`).toBeGreaterThanOrEqual(
        MIN_TOUCH_TARGET,
      );

      // And the drawn control stays smaller than its reach, which is the half
      // of this that a screenshot shows.
      expect(box!.height, `${name} drawn height`).toBeLessThan(
        MIN_TOUCH_TARGET,
      );
    }
  });
});

test.describe("thread controls under a mouse", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("keep their compact desktop size", async ({ page }) => {
    await mockBackend(page, {
      conversations: [conversation()],
      messages: [message()],
    });
    await page.goto("/chats/c1");
    await page.getByTestId("composer-input").waitFor();

    // The finger sizing must not leak into the pointer case: 44px header
    // buttons on a desktop thread would be chrome nobody asked for.
    const box = await page.getByTestId("thread-call").boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeLessThan(MIN_TOUCH_TARGET);
  });
});
