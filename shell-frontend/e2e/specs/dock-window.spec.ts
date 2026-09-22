import { authedTest as test, expect, isRemoteUp } from "../fixtures";

const MESSENGER_ENTRY = "http://localhost:4003/remoteEntry.js";

/** 20rem — the docked width, and the only width a window may ever have. */
const DOCK_WIDTH = 320;

const json = (body: unknown) => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify(body),
});

const conversationRow = {
  id: "c1",
  tenantId: "datha-platform",
  type: "direct",
  title: null,
  createdBy: "google_e2e-test-user",
  createdAt: "2026-09-08T09:00:00.000Z",
  lastMessageAt: "2026-09-08T10:00:00.000Z",
  lastActivityAt: "2026-09-08T10:00:00.000Z",
  participants: [
    { ownerId: "google_e2e-test-user", role: "admin", lastReadAt: null },
    { ownerId: "google_them", role: "member", lastReadAt: null },
  ],
  lastMessage: null,
  lastCall: null,
  unread: false,
};

/**
 * A docked chat window, hosted by the shell.
 *
 * This belongs in the shell's suite and cannot be written in the remote's:
 * `--messenger-dock-width` is declared in `messenger-frontend/src/styles/
 * base.scss`, a global stylesheet listed in that repo's `angular.json`, and a
 * Module Federation host **never loads it** — it pulls the remote's component
 * styles in with the JavaScript and nothing else. Standalone at :4003 the
 * property therefore resolves and every measurement is correct; inside the
 * shell it resolved to the empty string, `width: var(--messenger-dock-width)`
 * was invalid, and the window fell back to `width: auto` — sizing to its own
 * content and visibly widening as the thread loaded (dathq, 2026-09-17).
 */
test.describe("docked chat window in the shell", () => {
  test.beforeEach(async ({ page }) => {
    await page.routeWebSocket(/\/api\/realtime\/ws/, () => {});
    await page.route("**/api/realtime/token*", (r) =>
      r.fulfill(json({ stream_token: "t", expires_in: 90 })),
    );
    await page.route("**/api/accounts/users/lookup*", (r) =>
      r.fulfill(
        json({
          data: [
            {
              ownerId: "google_them",
              email: "them@example.com",
              displayName: "Them",
              pictureUrl: "",
            },
          ],
        }),
      ),
    );
    await page.route("**/api/messenger/conversations/unread*", (r) =>
      r.fulfill(json({ data: { conversation_ids: [] } })),
    );
    await page.route("**/api/messenger/conversations/*/messages*", (r) =>
      r.fulfill(json({ data: [], meta: { next_cursor: null } })),
    );
    await page.route("**/api/messenger/conversations/*/calls*", (r) =>
      r.fulfill(json({ data: [] })),
    );
    await page.route("**/api/messenger/conversations/*/read*", (r) =>
      r.fulfill(json({ data: {} })),
    );
    await page.route("**/api/messenger/conversations*", (r) =>
      r.fulfill(json({ data: [conversationRow], meta: { next_cursor: null } })),
    );
  });

  test("opens at its docked width and does not resize to its content", async ({
    page,
  }) => {
    test.skip(
      !(await isRemoteUp(MESSENGER_ENTRY)),
      "messenger remote not running — start it for dock coverage",
    );

    await page.goto("/messenger/chats");
    await page
      .getByTestId("conversation-dock")
      .first()
      .click({ timeout: 30_000 });

    const window = page.locator("messenger-chat-window");
    await expect(window).toBeVisible();

    // Sampled across frames, not once: the fault was a width that *changed*
    // after opening, so a single reading taken late would have passed against
    // it. Every frame must already be the docked width.
    const widths = await page.evaluate(async () => {
      const seen: number[] = [];
      for (let frame = 0; frame < 40; frame += 1) {
        const el = document.querySelector("messenger-chat-window");
        if (el) seen.push(Math.round(el.getBoundingClientRect().width));
        await new Promise((resolve) =>
          requestAnimationFrame(() => resolve(null)),
        );
      }
      return seen;
    });

    expect(widths.length).toBeGreaterThan(0);
    expect([...new Set(widths)]).toEqual([DOCK_WIDTH]);
  });
});
