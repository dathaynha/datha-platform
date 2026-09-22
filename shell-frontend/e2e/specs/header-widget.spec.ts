import {
  authedTest as test,
  expect,
  isRemoteUp,
  pickFromChipMenu,
} from "../fixtures";

const MESSENGER_ENTRY = "http://localhost:4003/remoteEntry.js";
const WIDGET = "Open messenger";

/**
 * The header widget slot: the shell renders remote-owned content from
 * `environment.headerWidgets` without importing it, and a remote that is down
 * must cost nothing but its own slot. Each case self-skips on the state it
 * cannot reproduce, like remotes.spec.ts.
 */
test.describe("messenger header widget", () => {
  test("a stopped remote leaves the header intact", async ({ page }) => {
    test.skip(
      await isRemoteUp(MESSENGER_ENTRY),
      "messenger remote is running — the empty slot is not reproducible",
    );

    await page.goto("/");

    // The rest of the header is chrome and must survive a dead product remote.
    await expect(
      page.getByRole("button", { name: "Open notifications" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Open profile menu" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: WIDGET })).toHaveCount(0);
    await expect(page.getByRole("dialog")).toBeHidden();
  });

  test("a running remote renders the widget and its popover", async ({
    page,
  }) => {
    test.skip(
      !(await isRemoteUp(MESSENGER_ENTRY)),
      "messenger remote not running — start it for widget coverage",
    );

    await page.goto("/");
    const trigger = page.getByRole("button", { name: WIDGET });
    await expect(trigger).toBeVisible();

    await trigger.click();
    const popover = page.getByRole("dialog");
    await expect(popover.getByText("No conversations yet")).toBeVisible();

    await popover
      .getByRole("button", { name: /see all in messenger/i })
      .click();
    await expect(page).toHaveURL(/\/messenger/);
  });

  test("the widget trigger matches the shell's own header controls", async ({
    page,
  }) => {
    test.skip(
      !(await isRemoteUp(MESSENGER_ENTRY)),
      "messenger remote not running — start it for widget coverage",
    );

    await page.goto("/");
    const box = async (name: string) =>
      await page.getByRole("button", { name }).boundingBox();

    const widget = await box(WIDGET);
    const bell = await box("Open notifications");

    // Header chrome must read as one set of controls, not a bolted-on remote.
    expect(widget?.width).toBe(bell?.width);
    expect(widget?.height).toBe(bell?.height);
  });

  test("switching language with the widget loaded keeps the shell's own catalog", async ({
    page,
  }) => {
    test.skip(
      !(await isRemoteUp(MESSENGER_ENTRY)),
      "messenger remote not running — start it for widget coverage",
    );

    // The widget merges its MESSENGER.* catalog into the shell's TranslateService.
    // Write a language the shell has not fetched yet and ngx-translate marks it
    // loaded, so the shell's own lazy catalog never arrives — the home page came
    // up blank in German. Re-registering on every langChange also re-entered
    // itself until the stack blew, which left the UI correct and the console on
    // fire, so both halves are asserted here.
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });

    await page.goto("/");
    await expect(page.getByRole("button", { name: WIDGET })).toBeVisible();

    await pickFromChipMenu(page, "datha-lang-select", /Deutsch/);

    await expect(
      page.getByRole("heading", { name: "Ihre Anwendungen" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Messenger öffnen" }),
    ).toBeVisible();
    // Network noise is expected here: the seeded JWT is not gateway-valid, so
    // the notification stream 401s. Anything else is an app-level error.
    const appErrors = errors.filter(
      (text) => !/Failed to load resource/i.test(text),
    );
    expect(appErrors).toEqual([]);

    await pickFromChipMenu(page, "datha-lang-select", /English/);
    await expect(
      page.getByRole("heading", { name: "Your Applications" }),
    ).toBeVisible();
  });

  test("on a narrow viewport the icon navigates instead of opening a popover", async ({
    page,
  }) => {
    test.skip(
      !(await isRemoteUp(MESSENGER_ENTRY)),
      "messenger remote not running — start it for widget coverage",
    );

    await page.setViewportSize({ width: 480, height: 900 });
    await page.goto("/");

    await page.getByRole("button", { name: WIDGET }).click();

    await expect(page).toHaveURL(/\/messenger/);
    await expect(page.getByRole("dialog")).toBeHidden();
  });

  test("an incoming call rings centred on the viewport, not inside the header", async ({
    page,
  }) => {
    test.skip(
      !(await isRemoteUp(MESSENGER_ENTRY)),
      "messenger remote not running — start it for call-dock coverage",
    );

    // Reported 2026-09-10: the ring appeared jammed into the top-right corner.
    // The shell's toolbar carries `backdrop-filter`, which creates a
    // containing block for fixed descendants, so the dock mounted inside the
    // header widget positioned against the *toolbar*. It is re-parented to
    // `body` now. This can only be caught in the shell — the standalone remote
    // has no toolbar and no trap.
    let socket: import("@playwright/test").WebSocketRoute | null = null;
    await page.routeWebSocket(/\/api\/realtime\/ws/, (ws) => {
      socket = ws;
    });
    const json = (body: unknown) => ({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
    await page.route("**/api/realtime/token*", (r) =>
      r.fulfill(json({ stream_token: "t", expires_in: 90 })),
    );
    await page.route("**/api/messenger/conversations*", (r) =>
      r.fulfill(json({ data: [], meta: { next_cursor: null } })),
    );
    await page.route("**/api/accounts/users/lookup*", (r) =>
      r.fulfill(
        json({
          data: [
            {
              ownerId: "google_them",
              email: "them@example.com",
              displayName: "Dat Ha",
              pictureUrl: "",
            },
          ],
        }),
      ),
    );

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await expect(page.getByRole("button", { name: WIDGET })).toBeVisible({
      timeout: 30_000,
    });
    await expect.poll(() => socket !== null, { timeout: 20_000 }).toBeTruthy();

    // The socket's `ready` frame is where the call service learns its own
    // owner id, and a mocked socket sends nothing unless told to. Without it
    // `selfOwnerId` stays "", so the invited set never includes this user, the
    // 1:1 peer cannot be picked out of a set of one, and the dock rings with
    // no name — which is what this spec was failing on, against a product
    // that was behaving correctly.
    socket!.send(
      JSON.stringify({ t: "ready", d: { owner_id: "google_e2e-test-user" } }),
    );

    const ring = {
      t: "call.incoming",
      d: {
        call_id: "11111111-1111-1111-1111-111111111111",
        conversation_id: "c1",
        from: "google_them",
        sdp: { type: "offer", sdp: "v=0-probe" },
      },
    };
    socket!.send(JSON.stringify(ring));

    const dock = page.getByTestId("call-dock");
    await expect(dock).toBeVisible({ timeout: 15_000 });

    // Out of the header entirely: a fixed child of the toolbar could not be.
    expect(await dock.evaluate((el) => !!el.closest("p-toolbar"))).toBe(false);

    // Centred on the viewport, within a few px of the middle.
    const box = (await dock.boundingBox())!;
    expect(Math.abs(box.x + box.width / 2 - 640)).toBeLessThan(12);
    expect(Math.abs(box.y + box.height / 2 - 400)).toBeLessThan(12);

    // The caller is named, even though no conversation with them was loaded.
    await expect(dock).toContainText("Dat Ha");
    // ...and the answer has focus, since this is a modal asking a question.
    await expect(
      page.locator('[data-testid="call-accept"] button'),
    ).toBeFocused();

    // The corner panel takes the same path: fixed against the viewport.
    socket!.send(
      JSON.stringify({
        t: "call.ended",
        d: {
          call_id: "11111111-1111-1111-1111-111111111111",
          reason: "declined",
        },
      }),
    );
    const notice = page.getByTestId("call-end-notice");
    await expect(notice).toBeVisible({ timeout: 15_000 });
    const noticeBox = (await notice.boundingBox())!;
    expect(800 - (noticeBox.y + noticeBox.height)).toBeLessThan(40);
    expect(1280 - (noticeBox.x + noticeBox.width)).toBeLessThan(40);
  });
});

/**
 * The unread badge, driven by the realtime socket.
 *
 * The socket itself is mocked in the browser (`routeWebSocket`) rather than
 * pointed at a running realtime-service: what these cases are about is the
 * frame → badge contract, and a mocked socket makes the frames exact and the
 * run hermetic. The socket's own behaviour is covered where it lives, by
 * realtime-service's Go tests.
 */
test.describe("messenger unread badge", () => {
  const BADGE = '[data-testid="messenger-unread-badge"]';

  /** Mocks the token mint, the unread resync, and the socket itself. */
  const mockRealtime = async (
    page: import("@playwright/test").Page,
    options: { initialUnread?: string[] } = {},
  ) => {
    // The trailing glob matters: the shell's interceptor appends ?culture=…,
    // and a pattern without it silently fails to match, letting the real
    // request through to the gateway.
    await page.route("**/api/realtime/token*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ stream_token: "e2e-token", expires_in: 90 }),
      }),
    );

    await page.route("**/api/messenger/conversations/unread*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: { conversation_ids: options.initialUnread ?? [] },
        }),
      }),
    );

    const sent: string[] = [];
    let server: import("@playwright/test").WebSocketRoute | null = null;
    await page.routeWebSocket(/\/api\/realtime\/ws/, (ws) => {
      server = ws;
      ws.onMessage((message) => sent.push(String(message)));
      // Nothing is connected upstream: this mock *is* the server.
    });

    return {
      sent,
      /** Pushes one server frame at the app, exactly as realtime-service would. */
      push: (frame: Record<string, unknown>) => {
        if (!server) throw new Error("the socket has not been opened yet");
        server.send(JSON.stringify(frame));
      },
      opened: () => server !== null,
    };
  };

  test("renders no badge when nothing is unread", async ({ page }) => {
    test.skip(
      !(await isRemoteUp(MESSENGER_ENTRY)),
      "messenger remote not running — start it for widget coverage",
    );
    await mockRealtime(page);

    await page.goto("/");
    await expect(page.getByRole("button", { name: WIDGET })).toBeVisible();
    await expect(page.locator(BADGE)).toHaveCount(0);
  });

  test("shows the unread count from the REST resync", async ({ page }) => {
    test.skip(
      !(await isRemoteUp(MESSENGER_ENTRY)),
      "messenger remote not running — start it for widget coverage",
    );
    await mockRealtime(page, { initialUnread: ["conv-1", "conv-2"] });

    await page.goto("/");
    // The badge counts unread *conversations*, and the set comes from
    // messenger-service rather than from the socket's ready frame.
    await expect(page.locator(BADGE)).toHaveText("2");
  });

  test("follows unread deltas from the socket", async ({ page }) => {
    test.skip(
      !(await isRemoteUp(MESSENGER_ENTRY)),
      "messenger remote not running — start it for widget coverage",
    );
    const socket = await mockRealtime(page);

    await page.goto("/");
    await expect(page.getByRole("button", { name: WIDGET })).toBeVisible();
    await expect.poll(() => socket.opened(), { timeout: 10_000 }).toBeTruthy();

    socket.push({ t: "unread.added", d: { conversation_id: "conv-1" } });
    await expect(page.locator(BADGE)).toHaveText("1");

    socket.push({ t: "unread.added", d: { conversation_id: "conv-2" } });
    await expect(page.locator(BADGE)).toHaveText("2");

    // A repeated frame is a no-op: unread is a set of ids, not a counter, so
    // duplicates cost nothing and a dropped frame self-heals on resync.
    socket.push({ t: "unread.added", d: { conversation_id: "conv-2" } });
    await expect(page.locator(BADGE)).toHaveText("2");

    socket.push({ t: "unread.cleared", d: { conversation_id: "conv-1" } });
    await expect(page.locator(BADGE)).toHaveText("1");

    socket.push({ t: "unread.cleared", d: { conversation_id: "conv-2" } });
    await expect(page.locator(BADGE)).toHaveCount(0);
  });

  test("caps the badge at 9+ and answers the keepalive", async ({ page }) => {
    test.skip(
      !(await isRemoteUp(MESSENGER_ENTRY)),
      "messenger remote not running — start it for widget coverage",
    );
    const socket = await mockRealtime(page);

    await page.goto("/");
    await expect(page.getByRole("button", { name: WIDGET })).toBeVisible();
    await expect.poll(() => socket.opened(), { timeout: 10_000 }).toBeTruthy();

    for (let i = 0; i < 10; i++) {
      socket.push({ t: "unread.added", d: { conversation_id: `conv-${i}` } });
    }
    await expect(page.locator(BADGE)).toHaveText("9+");

    socket.push({ t: "ping", d: {} });
    await expect
      .poll(() => socket.sent.some((frame) => frame.includes('"pong"')), {
        timeout: 10_000,
      })
      .toBeTruthy();
  });
});
