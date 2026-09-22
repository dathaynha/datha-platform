import { authedTest as test, expect } from "../fixtures";
import {
  CONVERSATION_ID,
  DEFAULT_CONVERSATION,
  mockChatApi,
} from "../chat-api-mock";

/**
 * Follow-bottom releases the first time you scroll up.
 *
 * Reported 2026-09-21: dragging up in an open thread "keeps glitching drag
 * down, takes a while to be able to drag up". Two mechanisms disagreed about
 * what a scroll-up was. An IntersectionObserver on a bottom sentinel
 * re-asserted the pin as soon as the sentinel left the viewport by 48px, while
 * `onThreadScroll` only released it past a 120px gap — so every drag landing
 * in between was pulled back before it could release. Measured:
 *
 *   wheel -40:  gap 40  -> 0    (snapped back)
 *   wheel -60:  gap 100 -> 0    (snapped back)
 *   wheel -150: gap 150 -> 150  (escaped)
 *
 * Which is exactly "flick hard enough and it finally works".
 *
 * Wheel deltas rather than `scrollTo`, because the bug is about a gesture
 * arriving in small increments; one big programmatic jump clears the old
 * threshold and passes against the broken code.
 */

const LONG_THREAD = Array.from({ length: 40 }, (_, i) => ({
  id: `m${i}`,
  role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
  content: `Message ${i}. ${"Long enough to wrap several times in the column. ".repeat(3)}`,
}));

const gap = (page: import("@playwright/test").Page) =>
  page
    .locator(".chat-thread")
    .evaluate((el) =>
      Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
    );

const openLongThread = async (page: import("@playwright/test").Page) => {
  await mockChatApi(page, {
    conversations: [DEFAULT_CONVERSATION],
    messages: LONG_THREAD,
  });
  await page.goto(`/chat?c=${CONVERSATION_ID}`);
  await page.locator(".chat-thread").waitFor();
  // The pin runs on a rAF after the thread renders; sampling before it has
  // settled would read a gap that is about to be closed anyway.
  await expect.poll(() => gap(page)).toBe(0);
};

test("a small drag up is not pulled back to the bottom", async ({ page }) => {
  await openLongThread(page);
  await page.locator(".chat-thread").hover();

  // 60px: past the old 48px re-pin, short of the old 120px release — the
  // middle of the band where the two mechanisms fought. One drag is not the
  // guard: whether a single one survived depended on which frame the
  // observers landed in, and this assertion passed against the old code.
  await page.mouse.wheel(0, -60);
  await page.waitForTimeout(300);
  expect(await gap(page)).toBeGreaterThanOrEqual(40);

  // *This* is the guard. Two drags must accumulate; under the old code the
  // second was pulled back to 0 every time (`Expected >= 100, Received 0`).
  await page.mouse.wheel(0, -60);
  await page.waitForTimeout(300);
  expect(await gap(page)).toBeGreaterThanOrEqual(100);
});

test("opening a thread still lands at the newest message", async ({ page }) => {
  // The pin exists for a reason; releasing it eagerly must not cost this.
  await openLongThread(page);
  expect(await gap(page)).toBe(0);
  await expect(page.getByText("Message 39.")).toBeVisible();
});
