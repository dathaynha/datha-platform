import type { Route } from "@playwright/test";
import { authedTest as test, expect } from "../fixtures";
import {
  OWNER,
  OTHER,
  conversation,
  json,
  message,
  mockBackend,
} from "../mock-backend";

/**
 * The chat UI in standalone mode. The gateway is route-mocked (no backend) and
 * the socket is mocked in the browser, so these cases assert exactly one thing:
 * that the UI does the right thing with the frames and responses it is given.
 * The services' own behaviour is covered by their own suites.
 */

/**
 * `expect.poll` defaults to 5s, and opening the socket means loading the
 * remote, minting a stream token and connecting. On a machine also running the
 * platform's dev servers and Docker that overran 5s about once in fifteen runs
 * — the same contention `playwright.config.ts` raises the test timeout for.
 */
const SOCKET_POLL = { timeout: 20_000 };

test.describe("messenger chat", () => {
  test("lists conversations with the other person's name", async ({ page }) => {
    await mockBackend(page);
    await page.goto("/chats");

    const rows = page.getByTestId("conversation-row");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Them");
    await expect(rows.first()).toContainText("first message");
    // Nothing selected: the composer belongs to a thread, so there is none.
    await expect(page.getByTestId("composer-input")).toHaveCount(0);
  });

  test("opens a thread into a linkable URL and renders its messages", async ({
    page,
  }) => {
    await mockBackend(page);
    await page.goto("/chats");
    await page.getByTestId("conversation-row").first().click();

    await expect(page).toHaveURL(/\/chats\/c1$/);
    await expect(page.getByTestId("thread-messages")).toContainText(
      "first message",
    );
    await expect(page.getByTestId("composer-input")).toBeVisible();
  });

  test("renders an opened thread directly from its URL", async ({ page }) => {
    await mockBackend(page);
    await page.goto("/chats/c1");

    await expect(page.getByTestId("thread-messages")).toContainText(
      "first message",
    );
  });

  test("sends optimistically and posts an idempotency key", async ({
    page,
  }) => {
    const backend = await mockBackend(page);
    await page.goto("/chats/c1");

    await page.getByTestId("composer-input").fill("hello from e2e");
    await page.getByTestId("composer-send").click();

    // On screen before the server is involved.
    await expect(page.getByTestId("thread-messages")).toContainText(
      "hello from e2e",
    );
    await expect.poll(() => backend.posted.length).toBe(1);
    expect(backend.posted[0]?.["client_message_id"]).toBeTruthy();
    // The composer clears, so a second Enter cannot resend the same text.
    await expect(page.getByTestId("composer-input")).toHaveValue("");
  });

  test("sends with Enter and keeps Shift+Enter for a new line", async ({
    page,
  }) => {
    const backend = await mockBackend(page);
    await page.goto("/chats/c1");

    const composer = page.getByTestId("composer-input");
    await composer.fill("line one");
    await composer.press("Shift+Enter");
    await expect.poll(() => backend.posted.length).toBe(0);

    await composer.press("Enter");
    await expect.poll(() => backend.posted.length).toBe(1);
  });

  test("shows an inbound socket message in the open thread", async ({
    page,
  }) => {
    const backend = await mockBackend(page);
    await page.goto("/chats/c1");
    await expect(page.getByTestId("thread-messages")).toBeVisible();
    await expect.poll(() => backend.socketOpened(), SOCKET_POLL).toBeTruthy();

    backend.push({
      t: "message.new",
      d: {
        conversation_id: "c1",
        message: message({ id: "socket-1", body: "arrived over the socket" }),
      },
    });

    await expect(page.getByTestId("thread-messages")).toContainText(
      "arrived over the socket",
    );
  });

  test("shows a typing indicator, then presence from the socket", async ({
    page,
  }) => {
    const backend = await mockBackend(page);
    await page.goto("/chats/c1");
    await expect.poll(() => backend.socketOpened(), SOCKET_POLL).toBeTruthy();

    backend.push({
      t: "typing",
      d: {
        conversation_id: "c1",
        owner_id: OTHER,
        until: new Date(Date.now() + 8000).toISOString(),
      },
    });
    await expect(page.getByTestId("typing-indicator")).toContainText("Them");

    backend.push({ t: "presence", d: { owner_id: OTHER, state: "online" } });
    await expect(page.getByText("Online")).toBeVisible();
  });

  test("authorizes the conversation on the socket before typing in it", async ({
    page,
  }) => {
    const backend = await mockBackend(page);
    await page.goto("/chats/c1");
    await expect.poll(() => backend.socketOpened(), SOCKET_POLL).toBeTruthy();

    // realtime-service refuses a typing frame for a thread that was never
    // opened, so the client must send conversation.open first.
    await expect
      .poll(() =>
        backend.sentFrames.some((frame) =>
          frame.includes('"conversation.open"'),
        ),
      )
      .toBeTruthy();

    await page.getByTestId("composer-input").fill("typing…");
    await expect
      .poll(() =>
        backend.sentFrames.some((frame) => frame.includes('"typing.start"')),
      )
      .toBeTruthy();
  });

  test("marks a read receipt on the sender's own message", async ({ page }) => {
    const backend = await mockBackend(page);
    await page.goto("/chats/c1");
    await expect.poll(() => backend.socketOpened(), SOCKET_POLL).toBeTruthy();

    const own = message({
      id: "own-1",
      senderOwnerId: OWNER,
      clientMessageId: "cm-own-1",
      body: "did you see this",
      createdAt: "2026-09-08T10:01:00.000Z",
    });
    backend.push({
      t: "message.new",
      d: { conversation_id: "c1", message: own },
    });
    await expect(page.getByTestId("thread-messages")).toContainText(
      "did you see this",
    );
    await expect(page.getByTestId("message-read")).toHaveCount(0);

    backend.push({
      t: "receipt.read",
      d: {
        conversation_id: "c1",
        owner_id: OTHER,
        last_read_at: "2026-09-08T10:02:00.000Z",
      },
    });

    await expect(page.getByTestId("message-read")).toHaveCount(1);
  });

  test("offers a retry when a send fails, without duplicating the message", async ({
    page,
  }) => {
    await mockBackend(page);
    await page.route("**/api/messenger/conversations/*/messages*", (route) => {
      if (route.request().method() === "POST") {
        return route.fulfill({ status: 500, body: "{}" });
      }
      return json(route, { data: [message()], meta: { next_cursor: null } });
    });
    await page.goto("/chats/c1");

    await page.getByTestId("composer-input").fill("will not land");
    await page.getByTestId("composer-send").click();

    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
    // One row, not two: the failed send stays in place to be retried.
    await expect(
      page.getByTestId("message-row").filter({ hasText: "will not land" }),
    ).toHaveCount(1);
  });

  test("filters the sidebar client-side", async ({ page }) => {
    await mockBackend(page, {
      conversations: [
        conversation(),
        conversation({
          id: "c2",
          title: "Design crew",
          type: "group",
          lastMessage: message({ id: "m2", body: "ship it" }),
        }),
      ],
    });
    await page.goto("/chats");
    await expect(page.getByTestId("conversation-row")).toHaveCount(2);

    await page
      .getByRole("searchbox", { name: "Search conversations" })
      .fill("design");

    await expect(page.getByTestId("conversation-row")).toHaveCount(1);
    await expect(page.getByTestId("conversation-row")).toContainText(
      "Design crew",
    );
  });

  test("starts a conversation from the directory", async ({ page }) => {
    await mockBackend(page, {
      conversations: [],
      directory: [
        {
          ownerId: OTHER,
          email: "them@example.com",
          displayName: "Them",
          pictureUrl: "",
        },
      ],
    });
    await page.goto("/chats");

    await page.getByTestId("start-conversation").click();
    await page.getByTestId("directory-search").fill("them");
    await page.getByTestId("directory-result").first().click();

    // A draft, not a conversation: the URL names the *person*, and nothing has
    // been written yet.
    await expect(page).toHaveURL(new RegExp(`/chats/new/${OTHER}$`));
    await expect(page.getByTestId("composer-input")).toBeVisible();
    await expect(page.getByTestId("thread-title")).toHaveText("Them");
  });

  test("opens the existing thread when picking someone already chatted with", async ({
    page,
  }) => {
    // Reported 2026-09-11: picking a person you already talk to opened an
    // empty draft, which reads as the history having been lost. The first
    // message did resolve to the same conversation, so nothing was ever
    // duplicated — it just looked that way.
    await mockBackend(page, {
      directory: [
        {
          ownerId: OTHER,
          email: "them@example.com",
          displayName: "Them",
          pictureUrl: "",
        },
      ],
    });
    await page.goto("/chats");
    await expect(page.getByTestId("conversation-row")).toHaveCount(1);

    await page.getByTestId("compose").click();
    await page.getByTestId("directory-search").fill("them");
    await page.getByTestId("directory-result").first().click();

    await expect(page).toHaveURL(/\/chats\/c1$/);
    await expect(page.getByTestId("thread-messages")).toContainText(
      "first message",
    );
  });

  test("does not create the conversation until the first message", async ({
    page,
  }) => {
    // Reported 2026-09-10: picking someone POSTed a conversation immediately,
    // so a misclick put an empty thread in *both* people's lists.
    const mock = await mockBackend(page, {
      conversations: [],
      directory: [
        {
          ownerId: OTHER,
          email: "them@example.com",
          displayName: "Them",
          pictureUrl: "",
        },
      ],
    });
    await page.goto("/chats");

    await page.getByTestId("start-conversation").click();
    await page.getByTestId("directory-search").fill("them");
    await page.getByTestId("directory-result").first().click();
    await expect(page.getByTestId("composer-input")).toBeVisible();

    expect(mock.conversationCreates).toHaveLength(0);

    await page.getByTestId("composer-input").fill("first words");
    await page.getByTestId("composer-send").click();

    // Now it exists, once, and the URL becomes the real conversation.
    await expect(page).toHaveURL(/\/chats\/c-new$/);
    expect(mock.conversationCreates).toHaveLength(1);
    expect(mock.posted).toHaveLength(1);
  });

  test("a draft survives a reload and still creates nothing", async ({
    page,
  }) => {
    const mock = await mockBackend(page, {
      conversations: [],
      directory: [
        {
          ownerId: OTHER,
          email: "them@example.com",
          displayName: "Them",
          pictureUrl: "",
        },
      ],
    });

    // The person is in the URL rather than in memory, so the draft is linkable.
    await page.goto(`/chats/new/${OTHER}`);
    await expect(page.getByTestId("composer-input")).toBeVisible();
    await expect(page.getByTestId("thread-title")).toHaveText("Them");
    expect(mock.conversationCreates).toHaveLength(0);
  });

  test("a draft offers no call button", async ({ page }) => {
    // There is no conversation to invite anyone into yet.
    await mockBackend(page, {
      conversations: [],
      directory: [
        {
          ownerId: OTHER,
          email: "them@example.com",
          displayName: "Them",
          pictureUrl: "",
        },
      ],
    });
    await page.goto(`/chats/new/${OTHER}`);
    await expect(page.getByTestId("composer-input")).toBeVisible();
    await expect(page.getByTestId("thread-call")).toHaveCount(0);
  });

  test("keeps the timestamp off the bubble until it is hovered", async ({
    page,
  }) => {
    // Reported 2026-09-10: a name and a timestamp inside every bubble made the
    // thread twice as tall as it needed to be. Both moved out — the name
    // entirely (a direct thread is already titled), the time onto hover.
    await mockBackend(page);
    await page.goto("/chats/c1");
    await expect(page.getByTestId("composer-input")).toBeVisible();

    const time = page.getByTestId("message-time").first();
    await expect(time).toBeHidden();

    await page.getByTestId("message-row").first().hover();
    await expect(time).toBeVisible();

    // The header names the person; the bubbles must not repeat it.
    await expect(page.getByTestId("thread-messages")).not.toContainText("Them");
  });

  test("keeps status out of the bubble and shows read once per thread", async ({
    page,
  }) => {
    // Reported 2026-09-10: a read tick inside the bubble, on its own line.
    // Read state is a property of the conversation, not of every message —
    // Messenger and iMessage both mark only the newest own message.
    await mockBackend(page, {
      messages: [
        message({ id: "m3", senderOwnerId: OWNER, body: "second of mine" }),
        message({ id: "m2", senderOwnerId: OWNER, body: "first of mine" }),
        message({ id: "m1", senderOwnerId: OTHER, body: "theirs" }),
      ],
      conversations: [
        conversation({
          participants: [
            { ownerId: OWNER, role: "admin", lastReadAt: null },
            {
              ownerId: OTHER,
              role: "member",
              lastReadAt: "2026-09-09T23:59:00.000Z",
            },
          ],
        }),
      ],
    });
    await page.goto("/chats/c1");
    await expect(page.getByTestId("composer-input")).toBeVisible();

    // Exactly one marker, for two own messages.
    await expect(page.getByTestId("message-read")).toHaveCount(1);
    // ...and it is not inside a bubble.
    await expect(
      page.locator(".message-bubble").locator('[data-testid="message-read"]'),
    ).toHaveCount(0);
    await expect(page.locator(".message-bubble .pi-check")).toHaveCount(0);
  });

  test("does not drag the reader down when they are up in the history", async ({
    page,
  }) => {
    // Pinning to the bottom on every new row yanks someone out of the history
    // they scrolled up to read. Every mainstream client only follows while you
    // are already at the bottom, and offers a way back otherwise.
    const many = Array.from({ length: 40 }, (_, i) =>
      message({
        id: `m${i}`,
        clientMessageId: `cm${i}`,
        body: `history line ${i}`,
        createdAt: `2026-09-08T10:${String(i).padStart(2, "0")}:00.000Z`,
      }),
    );
    const backend = await mockBackend(page, { messages: many });
    await page.goto("/chats/c1");
    await expect(page.getByTestId("composer-input")).toBeVisible();

    const scroller = page.getByTestId("thread-messages");
    await scroller.evaluate((el) => (el.scrollTop = 0));
    await expect(page.getByTestId("jump-to-latest")).toBeVisible();

    await expect.poll(() => backend.socketOpened(), SOCKET_POLL).toBeTruthy();
    backend.push({
      t: "message.new",
      d: {
        conversation_id: "c1",
        message: message({
          id: "new-1",
          clientMessageId: "cm-new-1",
          body: "arrived while reading",
        }),
      },
    });
    await expect(scroller).toContainText("arrived while reading");

    // Still where the reader left it.
    expect(await scroller.evaluate((el) => el.scrollTop)).toBeLessThan(80);

    await page.getByTestId("jump-to-latest").click();
    await expect(page.getByTestId("jump-to-latest")).toHaveCount(0);
  });

  test("grows the composer with a multi-line draft", async ({ page }) => {
    // rows="1" with no growth meant the `max-h-32` on the element was
    // unreachable and a multi-line draft scrolled inside a single line.
    await mockBackend(page);
    await page.goto("/chats/c1");
    const input = page.getByTestId("composer-input");
    await expect(input).toBeVisible();

    const single = await input.evaluate((el) => el.clientHeight);
    await input.fill("one\ntwo\nthree\nfour");

    // Polled, not sampled once: `fill` dispatches the input event and the
    // growth is applied in the handler, so a single read straight afterwards
    // raced the reflow about once in four full runs. This still fails outright
    // when the composer cannot grow at all.
    await expect
      .poll(() => input.evaluate((el) => el.clientHeight))
      .toBeGreaterThan(single);
  });

  test("keeps a long unbroken URL inside its bubble", async ({ page }) => {
    await mockBackend(page, {
      messages: [
        message({
          id: "m1",
          // No spaces and no hyphens: hyphens are break opportunities, so a
          // dashed URL wraps on its own and would prove nothing.
          body: "https://example.test/aVeryLongUnbrokenTokenWithNoBreakOpportunitiesWhatsoeverABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
        }),
      ],
    });
    await page.goto("/chats/c1");
    await expect(page.getByTestId("composer-input")).toBeVisible();

    // Measure the body, not the bubble: the bubble anchors an absolutely
    // positioned timestamp *outside* itself, which legitimately inflates its
    // scrollWidth and would mask the thing under test.
    const overflow = await page
      .locator(".message-body")
      .first()
      .evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);

    // The pane must not have gained a horizontal scrollbar either.
    const paneOverflow = await page
      .getByTestId("thread-messages")
      .evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(paneOverflow).toBeLessThanOrEqual(1);
  });

  test("shows a skeleton, never the empty state, while a thread loads", async ({
    page,
  }) => {
    // Reported 2026-09-10: reloading a thread URL flashed "Pick a
    // conversation" first, because the stage waited for the conversation
    // *detail* even though the id was already known.
    let release = false;
    const hold = async (r: Route, body: unknown) => {
      while (!release) await new Promise((res) => setTimeout(res, 25));
      return json(r, body);
    };

    await mockBackend(page);
    // A cold reload of a thread URL: neither the list nor the conversation
    // itself has arrived yet, which is the state that flashed the empty pane.
    await page.route("**/api/messenger/conversations/*/messages*", (r) =>
      hold(r, { data: [message()], meta: { next_cursor: null } }),
    );
    await page.route(/\/api\/messenger\/conversations\/[^/?]+(\?|$)/, (r) =>
      hold(r, { data: conversation() }),
    );
    await page.route("**/api/messenger/conversations*", (r) =>
      hold(r, { data: [conversation()], meta: { next_cursor: null } }),
    );

    await page.goto("/chats/c1");
    await expect(page.getByTestId("thread-skeleton")).toBeVisible();
    await expect(page.getByTestId("start-conversation")).toHaveCount(0);

    release = true;
    await expect(page.getByTestId("thread-skeleton")).toHaveCount(0);
    await expect(page.getByTestId("composer-input")).toBeVisible();
  });

  test("drops the read marker once the other person has replied", async ({
    page,
  }) => {
    // Reported 2026-09-10: "Seen" sat pinned to the last own message with the
    // other person's newer reply below it. A reply is proof of reading, so
    // Messenger shows nothing at all in that state.
    await mockBackend(page, {
      messages: [
        message({ id: "m2", senderOwnerId: OTHER, body: "their reply" }),
        message({ id: "m1", senderOwnerId: OWNER, body: "mine" }),
      ],
      conversations: [
        conversation({
          participants: [
            { ownerId: OWNER, role: "admin", lastReadAt: null },
            {
              ownerId: OTHER,
              role: "member",
              lastReadAt: "2026-09-09T23:59:00.000Z",
            },
          ],
        }),
      ],
    });
    await page.goto("/chats/c1");
    await expect(page.getByTestId("composer-input")).toBeVisible();
    await expect(page.getByTestId("thread-messages")).toContainText(
      "their reply",
    );

    await expect(page.getByTestId("message-read")).toHaveCount(0);
  });

  test("falls back to an initial when an avatar cannot load", async ({
    page,
  }) => {
    // Google's lh3 pictures do not always load in a third-party context, and a
    // broken image icon beside a message is worse than no picture.
    await mockBackend(page, {
      directory: [],
      conversations: [conversation()],
    });
    await page.route("**/api/accounts/users/lookup*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: [
            {
              ownerId: OTHER,
              email: "them@example.com",
              displayName: "Them",
              pictureUrl: "https://lh3.googleusercontent.test/definitely-404",
            },
          ],
        }),
      }),
    );
    await page.goto("/chats/c1");
    await expect(page.getByTestId("composer-input")).toBeVisible();

    const avatar = page.locator(".message-avatar").first();
    await expect(avatar).toHaveText("T");
    await expect(avatar.locator("img")).toHaveCount(0);
  });

  test("keeps own bubbles flush with the pane edge", async ({ page }) => {
    // Reported 2026-09-10: a wide dead strip down the right. The trailing slot
    // sat in the flex row and reserved the width of the timestamp it was
    // hiding, so an own bubble could never reach the edge. It is anchored to
    // the bubble and out of flow now — which also means hovering cannot shift
    // anything.
    await mockBackend(page, {
      messages: [message({ id: "m1", senderOwnerId: OWNER, body: "mine" })],
    });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/chats/c1");
    await expect(page.getByTestId("composer-input")).toBeVisible();

    const pane = (await page.getByTestId("thread-messages").boundingBox())!;
    const bubble = (await page
      .locator(".message-row.is-own .message-bubble")
      .first()
      .boundingBox())!;

    // Only the scroller's own px-4 should separate them.
    const gap = pane.x + pane.width - (bubble.x + bubble.width);
    expect(gap).toBeLessThanOrEqual(20);

    // ...and revealing the timestamp must not move the bubble.
    const before = bubble.x;
    await page.locator(".message-row.is-own .message-bubble").first().hover();
    const after = (await page
      .locator(".message-row.is-own .message-bubble")
      .first()
      .boundingBox())!;
    expect(after.x).toBe(before);
    await expect(page.getByTestId("message-time").first()).toBeVisible();
  });

  test("keeps the composer clear of the viewport edge", async ({ page }) => {
    // The reported bug (2026-09-09) was the composer sitting flush to the
    // bottom. Asserting the computed padding rather than eyeballing a
    // screenshot means a future layout change cannot quietly undo it; the
    // image is kept alongside as the thing a human can actually judge.
    await mockBackend(page);
    await page.goto("/chats/c1");
    await expect(page.getByTestId("composer-input")).toBeVisible();

    const padding = await page
      .locator("form.thread-composer")
      .evaluate((form) => {
        const style = getComputedStyle(form);
        return {
          bottom: parseFloat(style.paddingBottom),
          top: parseFloat(style.paddingTop),
        };
      });

    // pb-5 = 1.25rem, matching chatbot-frontend's composer footer.
    expect(padding.bottom).toBeGreaterThanOrEqual(20);
    expect(padding.top).toBeGreaterThanOrEqual(12);

    await expect(
      page.getByText("Enter to send", { exact: false }),
    ).toBeVisible();

    await page.setViewportSize({ width: 1000, height: 700 });
    await page.screenshot({
      path: "test-results/composer-spacing.png",
      clip: { x: 0, y: 480, width: 1000, height: 220 },
    });
  });

  test("keeps the conversation list and the thread from touching", async ({
    page,
  }) => {
    // Reported 2026-09-10: the two panes met on a hard border-r, so the whole
    // window read as one flat sheet. They are inset panels now. Measuring the
    // gutter rather than screenshotting means a later layout change cannot
    // quietly close it again.
    await mockBackend(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/chats/c1");
    await expect(page.getByTestId("composer-input")).toBeVisible();

    const sidebar = await page.locator("aside.chats-sidebar").boundingBox();
    const stage = await page.locator("section.chats-stage").boundingBox();
    if (!sidebar || !stage) throw new Error("panes not laid out");

    // sm:gap-3 = 0.75rem between the panes.
    expect(stage.x - (sidebar.x + sidebar.width)).toBeGreaterThanOrEqual(8);
    // ...and the page background has to show around them, not just between.
    expect(sidebar.x).toBeGreaterThanOrEqual(8);

    const radius = await page
      .locator("section.chats-stage")
      .evaluate((el) => parseFloat(getComputedStyle(el).borderTopLeftRadius));
    expect(radius).toBeGreaterThan(0);
  });

  test("clears the directory search when the dialog is reopened", async ({
    page,
  }) => {
    // The dialog component is never destroyed — the page only toggles its
    // `visible` input — so a stale query survived every close until it was
    // cleared by hand (reported 2026-09-09).
    await mockBackend(page, {
      conversations: [],
      directory: [
        {
          ownerId: OTHER,
          email: "them@example.com",
          displayName: "Them",
          pictureUrl: "",
        },
      ],
    });
    await page.goto("/chats");

    await page.getByTestId("start-conversation").click();
    const search = page.getByTestId("directory-search");
    await search.fill("a stale query nobody wants back");
    await expect(search).toHaveValue("a stale query nobody wants back");

    await page.keyboard.press("Escape");
    await expect(search).toBeHidden();

    await page.getByTestId("start-conversation").click();
    await expect(page.getByTestId("directory-search")).toHaveValue("");
    // And the box is ready to type into, which `autofocus` cannot do on a
    // second open.
    await expect(page.getByTestId("directory-search")).toBeFocused();
  });

  test("uploads an attachment and sends it as a message", async ({ page }) => {
    const backend = await mockBackend(page);
    await page.goto("/chats/c1");

    await page.getByTestId("composer-attach").setInputFiles({
      name: "spec.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4 e2e"),
    });

    // The card shows before Azure is involved, labelled with the filename.
    await expect(page.getByTestId("attachment-card")).toContainText("spec.pdf");

    // prepare → PUT straight to blob → confirm, in that order.
    await expect
      .poll(() => backend.uploads)
      .toEqual(["prepare", "blob-put", "confirm"]);

    await expect.poll(() => backend.posted.length).toBe(1);
    expect(backend.posted[0]?.["attachment_file_id"]).toBe("file-1");
    expect(backend.posted[0]?.["body"]).toBe("spec.pdf");
  });

  test("uploads a downscaled copy beside a photo and records its size", async ({
    page,
  }) => {
    // Nobody downstream can make the derivative: file-service neither proxies
    // blob bytes nor reads their content, so the client that holds the file is
    // the only place it can happen. Painting a 288px box from a multi-megabyte
    // original is what this replaces.
    const backend = await mockBackend(page);
    await page.goto("/chats/c1");

    // A real PNG, big and noisy enough that a downscale is worth making.
    const photo = await page.evaluate(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 1600;
      canvas.height = 1200;
      const context = canvas.getContext("2d")!;
      const pixels = context.createImageData(canvas.width, canvas.height);
      for (let i = 0; i < pixels.data.length; i += 4) {
        pixels.data[i] = (i * 7) % 255;
        pixels.data[i + 1] = (i * 13) % 255;
        pixels.data[i + 2] = (i * 29) % 255;
        pixels.data[i + 3] = 255;
      }
      context.putImageData(pixels, 0, 0);
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/png"),
      );
      return [...new Uint8Array(await blob!.arrayBuffer())];
    });

    await page.getByTestId("composer-attach").setInputFiles({
      name: "holiday.png",
      mimeType: "image/png",
      buffer: Buffer.from(photo),
    });

    await expect.poll(() => backend.posted.length).toBe(1);
    const sent = backend.posted[0]!;
    expect(sent["attachment_file_id"]).toBe("file-1");
    expect(sent["thumbnail_file_id"]).toBe("file-2");
    // The original's size, read off the decode — not the thumbnail's.
    expect(sent["media_width"]).toBe(1600);
    expect(sent["media_height"]).toBe(1200);

    // Two uploads, and the second is the smaller one.
    expect(backend.prepared.length).toBe(2);
    expect(backend.prepared[1]?.["mimeType"]).toBe("image/webp");
    expect(Number(backend.prepared[1]?.["sizeBytes"])).toBeLessThan(
      Number(backend.prepared[0]?.["sizeBytes"]),
    );

    // The bubble holds the picture's shape, so nothing below it jumps when the
    // bytes land.
    const shape = await page.getByTestId("attachment-image").evaluate((el) => {
      const [w, h] = getComputedStyle(el).aspectRatio.split("/");
      const box = el.getBoundingClientRect();
      return {
        ratio: Number(w) / Number(h ?? 1),
        painted: box.width / box.height,
      };
    });
    expect(shape.ratio).toBeCloseTo(1600 / 1200, 2);
    // And the box really is that shape on screen, not just in the declaration.
    expect(shape.painted).toBeCloseTo(1600 / 1200, 1);
  });

  test("opens an attachment through messenger-service, not file-service", async ({
    page,
  }) => {
    const backend = await mockBackend(page, {
      messages: [
        message({
          id: "m-att",
          kind: "attachment",
          body: "spec.pdf",
          attachmentFileId: "file-1",
          clientMessageId: "cm-att",
        }),
      ],
    });
    await page.goto("/chats/c1");

    const grants: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/attachment")) grants.push(request.url());
    });
    // Bounded: with no timeout, a click that opens no popup leaves this
    // pending for the whole test timeout — the `.catch` hides the rejection,
    // so the spec burned 60s before failing instead of a second (2026-09-10).
    // The grant URL below is the actual assertion; the popup is incidental.
    const opened = page
      .waitForEvent("popup", { timeout: 5_000 })
      .catch(() => null);

    await page.getByTestId("attachment-card").click();

    // The grant comes from messenger-service, which is the only party that
    // knows the reader is a participant; file-service is owner-scoped.
    await expect.poll(() => grants.length).toBe(1);
    expect(grants[0]).toContain(
      "/api/messenger/conversations/c1/messages/m-att/attachment",
    );
    await opened;
    expect(backend.posted.length).toBe(0);
  });

  test("shows an image attachment as the picture, not as a file row", async ({
    page,
  }) => {
    // Reported 2026-09-11: pictures and GIFs listed like any other file.
    const pixel =
      "data:image/svg+xml;base64," +
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160">' +
          '<rect width="240" height="160" fill="#22c55e"/></svg>',
      ).toString("base64");
    await mockBackend(page, {
      messages: [
        message({
          id: "m-img",
          kind: "attachment",
          body: "holiday.png",
          attachmentFileId: "file-1",
          clientMessageId: "cm-img",
        }),
      ],
    });
    await page.route("**/messages/*/attachment*", (route) =>
      json(route, {
        data: {
          name: "holiday.png",
          download_url: pixel,
          expires_at: "2026-09-08T10:05:00.000Z",
        },
      }),
    );
    await page.goto("/chats/c1");

    const picture = page.getByTestId("attachment-image");
    await expect(picture).toBeVisible();
    // The file card is what it replaces, not something it sits beside.
    await expect(page.getByTestId("attachment-card")).toHaveCount(0);

    // Painted, not merely present — and bounded, so a big image cannot take
    // the thread over.
    const box = await picture.locator("img").evaluate((img) => {
      const el = img as HTMLImageElement;
      const rect = el.getBoundingClientRect();
      return {
        naturalWidth: el.naturalWidth,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    });
    expect(box.naturalWidth).toBeGreaterThan(0);
    expect(box.width).toBeGreaterThan(0);
    expect(box.width).toBeLessThanOrEqual(18 * 16);
    expect(box.height).toBeLessThanOrEqual(20 * 16);

    // The bubble hugs the picture. Any slack is bubble background beside the
    // image — a coloured strip down one side on your own messages, which is
    // what dathq reported on 2026-09-11.
    const slack = await picture.evaluate((img) => {
      const bubble = img.closest(".message-bubble") as HTMLElement;
      return (
        Math.round(bubble.getBoundingClientRect().width) -
        Math.round(img.getBoundingClientRect().width)
      );
    });
    expect(slack).toBeLessThanOrEqual(2);
  });

  test("keeps pictures in the same column as every other message", async ({
    page,
  }) => {
    // Reported 2026-09-11: an own picture stopped short of the column its own
    // text bubbles line up with. The cause is intrinsic sizing — a picture
    // that shrinks against the height cap inside a button that keeps its full
    // width leaves background where the image is not.
    // Wider than the bubble is allowed to be, which is the case that broke:
    // the picture shrinks to the cap while its button keeps the picture's full
    // intrinsic width, and the difference is background beside the image.
    const wide =
      "data:image/svg+xml;base64," +
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="2400" height="1200">' +
          '<rect width="2400" height="1200" fill="#0ea5e9"/></svg>',
      ).toString("base64");
    await mockBackend(page, {
      messages: [
        message({
          id: "m-text",
          senderOwnerId: OWNER,
          body: "mine",
          clientMessageId: "cm-text",
        }),
        message({
          id: "m-img",
          senderOwnerId: OWNER,
          kind: "attachment",
          body: "wide.png",
          attachmentFileId: "file-1",
          clientMessageId: "cm-img",
          createdAt: "2026-09-08T10:00:10.000Z",
        }),
        message({
          id: "m-in",
          kind: "attachment",
          body: "wide.png",
          attachmentFileId: "file-1",
          clientMessageId: "cm-in",
          createdAt: "2026-09-08T10:00:20.000Z",
        }),
      ],
    });
    // No stored dimensions: exactly like every message sent before they existed.
    await page.route("**/messages/*/attachment*", (route) =>
      json(route, {
        data: {
          name: "wide.png",
          download_url: wide,
          expires_at: "2026-09-08T10:05:00.000Z",
          thumbnail_url: null,
          width: null,
          height: null,
        },
      }),
    );
    await page.goto("/chats/c1");
    await expect(page.getByTestId("attachment-image")).toHaveCount(2);
    await expect
      .poll(() =>
        page
          .getByTestId("attachment-image")
          .first()
          .locator("img")
          .evaluate((img) => (img as HTMLImageElement).naturalWidth),
      )
      .toBeGreaterThan(0);

    const geometry = await page.evaluate(() => {
      const box = (el: Element) => el.getBoundingClientRect();
      const ownText = document.querySelector(
        ".message-row.is-own .message-bubble:not(.is-media)",
      )!;
      return Array.from(
        document.querySelectorAll('[data-testid="attachment-image"]'),
      ).map((button) => {
        const bubble = button.closest(".message-bubble")!;
        const image = button.querySelector("img")!;
        return {
          own: button.closest(".message-row")!.classList.contains("is-own"),
          // Background beside the picture, in px. Anything here is the bug.
          slack: Math.round(box(bubble).width - box(image).width),
          offColumn: Math.round(
            Math.abs(box(bubble).right - box(ownText).right),
          ),
        };
      });
    });

    for (const row of geometry) {
      // The bubble is the picture — no background beside it, either side.
      expect(row.slack).toBeLessThanOrEqual(2);
      // And an own picture ends on the same column as an own text bubble.
      if (row.own) expect(row.offColumn).toBeLessThanOrEqual(2);
    }
  });

  test("is still at the newest message once pictures have loaded", async ({
    page,
  }) => {
    // A picture that lands taller than the space it was given pushes the
    // newest message off screen with nobody having scrolled (dathq).
    const tall =
      "data:image/svg+xml;base64," +
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="1400">' +
          '<rect width="600" height="1400" fill="#a855f7"/></svg>',
      ).toString("base64");
    const many = Array.from({ length: 12 }, (_, i) =>
      message({
        id: `m${i}`,
        clientMessageId: `cm${i}`,
        kind: i % 3 === 0 ? "attachment" : "text",
        body: i % 3 === 0 ? `pic${i}.png` : `line ${i}`,
        attachmentFileId: i % 3 === 0 ? "file-1" : null,
        createdAt: `2026-09-08T10:${String(i).padStart(2, "0")}:00.000Z`,
      }),
    );
    await mockBackend(page, { messages: many });
    await page.route("**/messages/*/attachment*", (route) =>
      json(route, {
        data: {
          name: "pic.png",
          download_url: tall,
          expires_at: "2026-09-08T10:05:00.000Z",
          thumbnail_url: null,
          width: null,
          height: null,
        },
      }),
    );
    await page.goto("/chats/c1");
    await expect(page.getByTestId("attachment-image").first()).toBeVisible();

    await expect
      .poll(() =>
        page
          .getByTestId("thread-messages")
          .evaluate((el) =>
            Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
          ),
      )
      .toBeLessThanOrEqual(2);
  });

  test("mints a fresh link when a picture's link has expired", async ({
    page,
  }) => {
    // A signed link expires; every mainstream client asks for another rather
    // than degrading the bubble. Falling straight back to the file card would
    // turn a routine expiry into a permanently broken picture.
    const good =
      "data:image/svg+xml;base64," +
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80">' +
          '<rect width="120" height="80" fill="#0ea5e9"/></svg>',
      ).toString("base64");
    await mockBackend(page, {
      messages: [
        message({
          id: "m-img",
          kind: "attachment",
          body: "holiday.png",
          attachmentFileId: "file-1",
          clientMessageId: "cm-img",
        }),
      ],
    });
    let grants = 0;
    await page.route("**/messages/*/attachment*", (route) => {
      grants += 1;
      return json(route, {
        data: {
          name: "holiday.png",
          // The first link is dead, as an expired SAS URL would be.
          download_url:
            grants === 1 ? "data:image/png;base64,bm90YW5pbWFnZQ==" : good,
          expires_at: "2026-09-08T10:05:00.000Z",
        },
      });
    });
    await page.goto("/chats/c1");

    const picture = page.getByTestId("attachment-image").locator("img");
    await expect(picture).toBeVisible();
    await expect
      .poll(() =>
        picture.evaluate((img) => (img as HTMLImageElement).naturalWidth),
      )
      .toBeGreaterThan(0);
    expect(grants).toBe(2);
    await expect(page.getByTestId("attachment-card")).toHaveCount(0);
  });

  test("shows a notice when an attachment cannot be opened", async ({
    page,
  }) => {
    await mockBackend(page, {
      messages: [
        message({
          id: "m-att",
          kind: "attachment",
          body: "spec.pdf",
          attachmentFileId: "file-1",
          clientMessageId: "cm-att",
        }),
      ],
    });
    // An expired or revoked grant must surface inline, never as a modal.
    await page.route("**/messages/*/attachment*", (route) =>
      route.fulfill({ status: 502, body: "{}" }),
    );
    await page.goto("/chats/c1");

    await page.getByTestId("attachment-card").click();

    await expect(page.getByTestId("attachment-error")).toBeVisible();
    await expect(page.locator(".p-dialog-mask")).toHaveCount(0);
  });
});
