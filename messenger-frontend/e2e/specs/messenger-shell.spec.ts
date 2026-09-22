import type { Page, Route } from "@playwright/test";
import { authedTest as test, expect } from "../fixtures";

/**
 * The Chats page calls the gateway now, and the seeded JWT is not
 * gateway-valid, so an unmocked run gets 401s and the interceptor's
 * session-expired path takes over the page. Mocking an empty account keeps
 * these cases about the chrome and the zero states, which is what they cover;
 * the chat UI itself lives in chat.spec.ts.
 */
const json = (route: Route, body: unknown) =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });

async function mockEmptyAccount(page: Page): Promise<void> {
  await page.routeWebSocket(/\/api\/realtime\/ws/, () => {});
  await page.route("**/api/realtime/token*", (route) =>
    json(route, { stream_token: "e2e-token", expires_in: 90 }),
  );
  await page.route("**/api/messenger/conversations/unread*", (route) =>
    json(route, { data: { conversation_ids: [] } }),
  );
  await page.route("**/api/messenger/conversations*", (route) =>
    json(route, { data: [], meta: { next_cursor: null } }),
  );
  await page.route("**/api/accounts/users*", (route) =>
    json(route, { data: [] }),
  );
}

/**
 * Standalone smoke coverage for the phase-0 skeleton: the remote boots on its
 * own (no shell, no backend), lands on the Overview page, and reaches Chats.
 */
test.describe("messenger standalone", () => {
  test.beforeEach(async ({ page }) => {
    await mockEmptyAccount(page);
  });

  test("lands on the overview page", async ({ page }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "Messenger", level: 1 }),
    ).toBeVisible();
    await expect(page.getByText("Tech we use")).toBeVisible();
  });

  test("switches the overview between the message and call flows", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByText("POST /api/messenger")).toBeVisible();

    await page.getByRole("tab", { name: "Placing a call" }).click();

    await expect(page.getByText("createOffer")).toBeVisible();
    await expect(page.getByText("POST /api/messenger")).toBeHidden();
  });

  test("opens a flow step detail panel", async ({ page }) => {
    await page.goto("/");
    await page
      .getByRole("button", { name: /TURN credentials|Composer/ })
      .first()
      .click();

    await expect(page.getByText("What happens here")).toBeVisible();
  });

  test("navigates to chats and offers starting the first conversation", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Chats" }).click();

    await expect(page).toHaveURL(/\/chats$/);
    await expect(
      page.getByText("No conversations yet", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Start your first conversation" }),
    ).toBeVisible();
    // The composer belongs to a thread; with none open there must be no text box.
    await expect(page.locator("textarea")).toHaveCount(0);

    // The CTA opens the directory dialog — the one place people search is done.
    await page.getByTestId("start-conversation").click();
    await expect(page.getByTestId("directory-search")).toBeVisible();
  });

  test("shows both tabs in the sub-header", async ({ page }) => {
    await page.goto("/");
    const nav = page.getByRole("navigation", { name: "Messenger sections" });

    await expect(nav.getByRole("link", { name: "Overview" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Chats" })).toBeVisible();
  });

  test("mounts the call dock standalone, so :4003 can run a call on its own", async ({
    page,
  }) => {
    /*
     * A remote has to work without the shell — that is the point of the
     * architecture (dathq, 2026-09-15). The call *buttons* are ordinary thread
     * chrome and always rendered here, but the dock used to be mounted only by
     * `HeaderWidgetComponent`, which only the shell renders. So standalone had
     * a button that started a real call it could neither show nor hang up.
     *
     * The dock renders nothing until there is a call and re-parents itself to
     * `body`, so this asserts the mount point exists rather than any visible
     * chrome — which is exactly the thing that was missing.
     */
    await page.goto("/chats");

    await expect(page.locator("body > messenger-call-dock")).toHaveCount(1);
  });
});
