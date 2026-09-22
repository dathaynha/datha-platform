import { authedTest as test, expect } from "../fixtures";
import {
  mockChatApi,
  openStubbedThread,
  scrollToTopUntil,
  settleAtBottom,
} from "../chat-api-mock";

/** Jump-to-latest button: appears once scrolled away from the bottom, returns there. */

const LONG_THREAD = Array.from({ length: 30 }, (_, i) => ({
  id: `msg-${i}`,
  role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
  content: `Message ${i} — ${"filler ".repeat(20)}`,
}));

const THREAD = ".chat-thread";

test("appears when scrolled up and returns to the newest message", async ({
  page,
}) => {
  await mockChatApi(page, { messages: LONG_THREAD });
  await openStubbedThread(page);

  await settleAtBottom(page);

  const jump = page.getByRole("button", { name: "Scroll to latest message" });

  // Opening a thread lands at the bottom — nothing to jump to.
  await expect(jump).toBeHidden();

  await scrollToTopUntil(page, () => jump.isVisible());
  await expect(jump).toBeVisible();

  await jump.click();

  await expect(jump).toBeHidden();
  // settleAtBottom polls with a 10s budget; the default 5s can lose to a smooth
  // scroll on a loaded machine.
  await settleAtBottom(page);
});

test("stays hidden for a small scroll nudge", async ({ page }) => {
  await mockChatApi(page, { messages: LONG_THREAD });
  await openStubbedThread(page);

  await settleAtBottom(page);
  const thread = page.locator(THREAD);

  // Inside THREAD_JUMP_TO_BOTTOM_GAP_PX (240) — follow-bottom releases here,
  // but the button must not appear for a nudge.
  await thread.evaluate((el) =>
    el.scrollTo({ top: el.scrollHeight - el.clientHeight - 100 }),
  );

  await expect(
    page.getByRole("button", { name: "Scroll to latest message" }),
  ).toBeHidden();
});

test("sits above the composer, horizontally centred", async ({ page }) => {
  await mockChatApi(page, { messages: LONG_THREAD });
  await openStubbedThread(page);

  await settleAtBottom(page);

  const jump = page.getByRole("button", { name: "Scroll to latest message" });
  await scrollToTopUntil(page, () => jump.isVisible());
  await expect(jump).toBeVisible();

  const button = await jump.boundingBox();
  const composer = await page.locator(".chat-composer").boundingBox();
  const stage = await page.locator(".chat-stage").boundingBox();
  expect(button && composer && stage).toBeTruthy();
  if (!button || !composer || !stage) {
    return;
  }

  // Fully clear of the composer's top edge (no overlap with the divider).
  expect(button.y + button.height).toBeLessThanOrEqual(composer.y);
  // Centred on the stage, within a small tolerance.
  const buttonCentre = button.x + button.width / 2;
  const stageCentre = stage.x + stage.width / 2;
  expect(Math.abs(buttonCentre - stageCentre)).toBeLessThan(8);
});
