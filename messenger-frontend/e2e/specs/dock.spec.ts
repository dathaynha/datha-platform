import { authedTest as test, expect } from "../fixtures";
import { mockBackend } from "../mock-backend";

/**
 * Docked mini chat windows — phase 3 slice 4.
 *
 * Standalone, at :4003, on purpose. The shell's header widget is the other way
 * in and the obvious one to test, and it would prove nothing about the case
 * that has bitten this remote before: a capability reachable only from the host
 * is a capability the product does not have (dathq, 2026-09-15). The strip and
 * the list's dock button both have to work with no shell present.
 *
 * Geometry rather than structure. Three "the stage is blank" reports on
 * 2026-09-16 were one fault — a box with no definite size — and every
 * structural assertion passed throughout.
 */
test.describe("docked chat windows", () => {
  test("keeps a conversation open across a navigation", async ({ page }) => {
    await mockBackend(page);
    await page.goto("/chats");

    await page.getByTestId("conversation-row").first().hover();
    await page.getByTestId("conversation-dock").first().click();

    // The strip drops a window for the thread this page is already showing,
    // so leaving /chats is what makes it appear — which is the feature.
    await page
      .getByRole("link", { name: /overview/i })
      .first()
      .click();
    await expect(page).not.toHaveURL(/\/chats/);

    const window_ = page.locator("messenger-chat-window");
    await expect(window_).toHaveCount(1);
    await expect(window_.getByTestId("thread-title")).toContainText("Them");

    const box = (await window_.boundingBox())!;
    expect(box.width).toBeGreaterThan(200);
    expect(box.height).toBeGreaterThan(200);

    // The composer is the thing a window exists for, and it is the first
    // casualty of a box that sizes to its content.
    const composer = (await window_
      .getByTestId("composer-input")
      .boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(composer.y + composer.height).toBeLessThanOrEqual(viewport.height);
    expect(composer.x).toBeGreaterThanOrEqual(box.x);
  });

  test("sends from the window without leaving the page", async ({ page }) => {
    await mockBackend(page);
    await page.goto("/chats");
    await page.getByTestId("conversation-row").first().hover();
    await page.getByTestId("conversation-dock").first().click();
    await page
      .getByRole("link", { name: /overview/i })
      .first()
      .click();

    const window_ = page.locator("messenger-chat-window");
    const composer = window_.getByTestId("composer-input");
    await composer.fill("from the dock");
    await composer.press("Enter");

    await expect(window_.getByTestId("thread-messages")).toContainText(
      "from the dock",
    );
    // Still on the page it was sent from: a window that navigates is a link.
    await expect(page).not.toHaveURL(/\/chats/);
  });

  test("collapses to a bar and back", async ({ page }) => {
    await mockBackend(page);
    await page.goto("/chats");
    await page.getByTestId("conversation-row").first().hover();
    await page.getByTestId("conversation-dock").first().click();
    await page
      .getByRole("link", { name: /overview/i })
      .first()
      .click();

    const window_ = page.locator("messenger-chat-window");
    const open = (await window_.boundingBox())!.height;

    await window_.getByTestId("dock-minimise").click();
    // Wait for the state, then measure: a rect read in the same tick as the
    // click is a race, and a racing measurement reads as a layout bug.
    await expect(window_.getByTestId("composer-input")).toHaveCount(0);
    const collapsed = (await window_.boundingBox())!.height;
    expect(collapsed).toBeLessThan(open);

    await window_.getByTestId("dock-expand").click();
    await expect(window_.getByTestId("composer-input")).toHaveCount(1);
    expect((await window_.boundingBox())!.height).toBeGreaterThan(collapsed);
  });

  test("closes, and stays closed after a reload", async ({ page }) => {
    await mockBackend(page);
    await page.goto("/chats");
    await page.getByTestId("conversation-row").first().hover();
    await page.getByTestId("conversation-dock").first().click();
    await page
      .getByRole("link", { name: /overview/i })
      .first()
      .click();

    await page
      .locator("messenger-chat-window")
      .getByTestId("dock-close")
      .click();
    await expect(page.locator("messenger-chat-window")).toHaveCount(0);

    await page.reload();
    await expect(page.locator("messenger-chat-window")).toHaveCount(0);
  });

  test("puts the window back after a reload", async ({ page }) => {
    await mockBackend(page);
    await page.goto("/chats");
    await page.getByTestId("conversation-row").first().hover();
    await page.getByTestId("conversation-dock").first().click();
    await page
      .getByRole("link", { name: /overview/i })
      .first()
      .click();
    await expect(page.locator("messenger-chat-window")).toHaveCount(1);

    await page.reload();

    const window_ = page.locator("messenger-chat-window");
    await expect(window_).toHaveCount(1);
    // Restored *and* re-subscribed: a window whose thread nothing feeds is a
    // screenshot of a conversation.
    await expect(window_.getByTestId("thread-messages")).toContainText(
      "first message",
    );
  });
});
