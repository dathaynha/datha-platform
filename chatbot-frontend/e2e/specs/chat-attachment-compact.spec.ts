import { authedTest as test, expect } from "../fixtures";
import { mockChatApi } from "../chat-api-mock";

/**
 * An attached file on a short screen.
 *
 * Reported 2026-09-21 with a screenshot: attaching a file in landscape pushed
 * the send controls off the bottom. Measured at 667x375 — the strip was
 * **95px**, taller than the 51px thread beneath it, and the composer took
 * 195px of a 295px stage. `.chat-stage` is `overflow: hidden`, so hosted the
 * overflow was gone rather than scrolled to, and nothing overflowed the
 * document to raise a scrollbar.
 *
 * A tile becomes a chip: the thumbnail shrinks to a square beside the name
 * rather than sitting above it. Ten attachments are allowed, so the strip is
 * also `nowrap` and scrolls sideways — otherwise a second row puts the screen
 * straight back where it was.
 */

const PNG = {
  name: "a-picture-with-quite-a-long-name.png",
  mimeType: "image/png",
  buffer: Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
};

const attachOne = async (page: import("@playwright/test").Page) => {
  await mockChatApi(page);
  await page.goto("/chat");
  await page.locator(".chat-thread").waitFor();
  await page.locator('input[type="file"]').setInputFiles([PNG]);
  await expect(page.locator(".chat-attachment-card")).toBeVisible();
};

const box = async (page: import("@playwright/test").Page, sel: string) => {
  const b = await page.locator(sel).boundingBox();
  expect(b, `${sel} should be rendered`).not.toBeNull();
  return b!;
};

test.describe("attaching a file on a landscape phone", () => {
  test.use({ viewport: { width: 667, height: 375 } });

  test("stays a chip, and leaves the send controls on screen", async ({
    page,
  }) => {
    await attachOne(page);

    const strip = await box(page, ".chat-attachment-strip");
    expect(strip.height).toBeLessThan(56);

    // The thread keeps more room than the thing describing what you attached.
    const thread = await box(page, ".chat-thread");
    expect(thread.height).toBeGreaterThan(strip.height);

    // The ancestor clips, so this is the assertion the bug would have failed:
    // past the bottom edge is gone, not scrolled to.
    const composer = await box(page, ".chat-composer");
    expect(composer.y + composer.height).toBeLessThanOrEqual(376);

    // Compacting is not an excuse to shrink what you press, and the thumbnail
    // stays — it is how you tell which picture you picked.
    const remove = await box(page, ".chat-attachment-remove");
    expect(remove.height).toBeGreaterThanOrEqual(28);
    const thumb = await box(page, ".chat-attachment-thumb");
    expect(thumb.width).toBeGreaterThanOrEqual(32);

    // Side by side, not stacked: that is what makes it a chip.
    const name = await box(page, ".chat-attachment-name");
    expect(name.y).toBeLessThan(thumb.y + thumb.height);
  });
});

test.describe("attaching a file on a portrait phone", () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test("is a chip here too", async ({ page }) => {
    await attachOne(page);

    // Reported the same day as the landscape case: 95px of a 490px stage is
    // still too much to spend saying which file is attached.
    const strip = await box(page, ".chat-attachment-strip");
    expect(strip.height).toBeLessThan(56);

    const thumb = await box(page, ".chat-attachment-thumb");
    const name = await box(page, ".chat-attachment-name");
    expect(name.y).toBeLessThan(thumb.y + thumb.height);
  });
});

test.describe("attaching a file with room to spare", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("keeps the tile and its full-width preview", async ({ page }) => {
    await attachOne(page);

    const thumb = await box(page, ".chat-attachment-thumb");
    const name = await box(page, ".chat-attachment-name");
    // Stacked: the name starts below the thumbnail, which is the tile.
    expect(name.y).toBeGreaterThanOrEqual(thumb.y + thumb.height - 1);
    expect(thumb.height).toBeGreaterThan(56);
  });
});
