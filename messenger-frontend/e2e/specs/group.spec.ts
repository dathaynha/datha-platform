import { authedTest as test, expect } from "../fixtures";
import {
  OWNER,
  OTHER,
  conversation,
  message,
  mockBackend,
} from "../mock-backend";

/**
 * Opening the socket means loading the remote, minting a stream token and
 * connecting, which overruns `expect.poll`'s 5s default on a loaded machine.
 */
const SOCKET_POLL = { timeout: 20_000 };

/**
 * Group conversations in standalone mode, against the mocked gateway.
 *
 * The backend for all of this shipped with phase 1 and had **no caller**: the
 * only create path in the app hard-coded `type: "direct"`, so four working
 * endpoints were unreachable. These cases exist to keep that from happening
 * again quietly — each one drives a control that did not exist before.
 */

const THIRD = "google_third";

const group = (overrides: Record<string, unknown> = {}) =>
  conversation({
    id: "g1",
    type: "group",
    title: "Release crew",
    participants: [
      { ownerId: OWNER, role: "admin", lastReadAt: null },
      { ownerId: OTHER, role: "member", lastReadAt: null },
      { ownerId: THIRD, role: "member", lastReadAt: null },
    ],
    ...overrides,
  });

const directory = [
  {
    ownerId: OTHER,
    email: "them@example.com",
    displayName: "Them",
    pictureUrl: "",
  },
  {
    ownerId: THIRD,
    email: "third@example.com",
    displayName: "Third Person",
    pictureUrl: "",
  },
];

test.describe("messenger groups", () => {
  test("creates a group from the compose dialog", async ({ page }) => {
    const backend = await mockBackend(page, { directory });
    await page.goto("/chats");

    await page.getByTestId("compose").click();
    await page.getByTestId("new-group").click();
    await page.getByTestId("directory-search").fill("e");

    const results = page.getByTestId("directory-result");
    await expect(results).toHaveCount(2);

    // People without a name is not enough: a group here is always named, which
    // is what lets it hold a single other member without being confusable with
    // the direct chat.
    await results.nth(0).click();
    await expect(page.getByTestId("group-create")).toBeDisabled();

    // A name of only spaces is not a name.
    await page.getByTestId("group-title").fill("   ");
    await expect(page.getByTestId("group-create")).toBeDisabled();

    // One other person plus a name is a group.
    await page.getByTestId("group-title").fill("Release crew");
    await expect(page.getByTestId("group-create")).toBeEnabled();

    await results.nth(1).click();
    await page.getByTestId("group-create").click();

    await expect.poll(() => backend.conversationCreates.length).toBe(1);
    expect(backend.conversationCreates[0]).toEqual({
      type: "group",
      participant_owner_ids: [OTHER, THIRD],
      title: "Release crew",
    });
  });

  test("creates a group with a single other person", async ({ page }) => {
    // The whole reason the name is mandatory: two people, named, and it is a
    // different thing from the direct chat with them.
    const backend = await mockBackend(page, { directory });
    await page.goto("/chats");

    await page.getByTestId("compose").click();
    await page.getByTestId("new-group").click();
    await page.getByTestId("directory-search").fill("e");
    await page.getByTestId("directory-result").nth(0).click();
    await page.getByTestId("group-title").fill("Just us");
    await page.getByTestId("group-create").click();

    await expect.poll(() => backend.conversationCreates.length).toBe(1);
    expect(backend.conversationCreates[0]).toEqual({
      type: "group",
      participant_owner_ids: [OTHER],
      title: "Just us",
    });
  });

  test("picking one person still opens a direct draft without writing", async ({
    page,
  }) => {
    // Group mode must not leak into the single-person path: that one creates
    // nothing until the first message is sent.
    const backend = await mockBackend(page, { directory });
    await page.goto("/chats");

    await page.getByTestId("compose").click();
    await page.getByTestId("directory-search").fill("e");
    // The third person has no thread yet; picking OTHER would correctly open
    // the existing conversation the default mock already carries.
    await page
      .getByTestId("directory-result")
      .filter({ hasText: "Third Person" })
      .click();

    await expect(page).toHaveURL(new RegExp(`/chats/new/${THIRD}$`));
    expect(backend.conversationCreates).toHaveLength(0);
  });

  test("shows a group's members in the header and a face for each", async ({
    page,
  }) => {
    await mockBackend(page, { conversations: [group()], directory });
    await page.goto("/chats/g1");

    await expect(page.getByTestId("thread-title")).toHaveText("Release crew");
    await expect(page.getByTestId("thread-subtitle")).toHaveText("3 members");

    // A group tile carries member faces, not a letter from the title.
    const faces = page
      .getByTestId("conversation-row")
      .first()
      .locator("messenger-avatar");
    await expect(faces).toHaveCount(2);

    // Both faces have to be inside the tile and actually painted: a stacked
    // avatar that collapses to zero is invisible and no class assertion sees it.
    const boxes = await faces.evaluateAll((nodes) =>
      nodes.map((node) => {
        const rect = node.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      }),
    );
    for (const box of boxes) {
      expect(box.width).toBeGreaterThan(8);
      expect(box.height).toBeGreaterThan(8);
    }
  });

  test("a direct thread keeps one face and its presence dot", async ({
    page,
  }) => {
    await mockBackend(page, { directory });
    await page.goto("/chats/c1");

    const row = page.getByTestId("conversation-row").first();
    await expect(row.locator("messenger-avatar")).toHaveCount(1);
    await expect(row.locator(".presence-dot")).toHaveCount(1);
    // A group has no single presence, so it must not claim one.
    await expect(page.getByTestId("thread-details")).toHaveCount(0);
  });

  test("renames a group, and refuses to clear the name", async ({ page }) => {
    const backend = await mockBackend(page, {
      conversations: [group()],
      directory,
    });
    await page.goto("/chats/g1");

    await page.getByTestId("thread-details").click();
    await expect(page.getByTestId("group-member")).toHaveCount(3);

    await page.getByTestId("group-rename-input").fill("Ops");
    await page.getByTestId("group-rename-save").click();
    await expect.poll(() => backend.renamed.length).toBe(1);
    expect(backend.renamed[0]).toEqual({ title: "Ops" });

    // Clearing the box is an unfinished edit, not a way to un-name a group —
    // a group here always has a name, so Save stays out of reach.
    await page.getByTestId("group-rename-input").fill("   ");
    await expect(page.getByTestId("group-rename-save")).toBeDisabled();
    expect(backend.renamed).toHaveLength(1);
  });

  test("adds people, filtering out those already in the group", async ({
    page,
  }) => {
    const backend = await mockBackend(page, {
      conversations: [group()],
      directory: [
        ...directory,
        {
          ownerId: "google_fourth",
          email: "fourth@example.com",
          displayName: "Fourth Person",
          pictureUrl: "",
        },
      ],
    });
    await page.goto("/chats/g1");

    await page.getByTestId("thread-details").click();
    await page.getByTestId("group-add-open").click();
    await page.getByTestId("group-add-search").fill("e");

    // Two of the three results are already members and must not be offered.
    const results = page.getByTestId("group-add-result");
    await expect(results).toHaveCount(1);
    await expect(results.first()).toContainText("Fourth Person");

    // Picking someone shows a chip, exactly as creating a group does — the
    // row highlight alone vanished as soon as the list scrolled, so who you
    // had picked was invisible (dathq, 2026-09-14).
    await results.first().click();
    await expect(page.getByTestId("group-chip")).toHaveCount(1);
    await expect(page.getByTestId("group-chip")).toContainText("Fourth Person");

    await page.getByTestId("group-add-confirm").click();

    await expect.poll(() => backend.added.length).toBe(1);
    expect(backend.added[0]).toEqual({ owner_ids: ["google_fourth"] });
  });

  test("removes an added person by their chip", async ({ page }) => {
    await mockBackend(page, {
      conversations: [group()],
      directory: [
        ...directory,
        {
          ownerId: "google_fourth",
          email: "fourth@example.com",
          displayName: "Fourth Person",
          pictureUrl: "",
        },
      ],
    });
    await page.goto("/chats/g1");

    await page.getByTestId("thread-details").click();
    await page.getByTestId("group-add-open").click();
    await page.getByTestId("group-add-search").fill("e");
    await page.getByTestId("group-add-result").first().click();
    await expect(page.getByTestId("group-chip")).toHaveCount(1);

    // The chip is the remove control, so confirm gates on it going away.
    await page.getByTestId("group-chip").click();
    await expect(page.getByTestId("group-chip")).toHaveCount(0);
    await expect(page.getByTestId("group-add-confirm")).toBeDisabled();
  });

  test("shows the same group faces to everyone, including yourself", async ({
    page,
  }) => {
    // Rendering only the *other* members made the picture viewer-relative: in
    // a three-way group each person saw a different pair, so it was a picture
    // of everyone-but-you rather than of the group (dathq, 2026-09-14). Sorted
    // by owner id, capped at two, and the viewer is in the running like anyone
    // else.
    await mockBackend(page, { conversations: [group()], directory });
    await page.goto("/chats");

    const faces = page
      .getByTestId("conversation-row")
      .first()
      .locator("messenger-avatar");
    // The names arrive with the directory lookup, so the initials are not
    // final the moment the row paints.
    await expect(faces).toHaveCount(2);
    await expect(faces.first()).toHaveText("E");

    const initials = await faces.evaluateAll((nodes) =>
      nodes.map((n) => (n.textContent ?? "").trim()),
    );

    // OWNER sorts first of the three, so this viewer's own initial must appear.
    expect(initials).toEqual(["E", "T"]);
  });

  test("leaving asks first, can be cancelled, and then drops the conversation", async ({
    page,
  }) => {
    const backend = await mockBackend(page, {
      conversations: [group()],
      directory,
    });
    await page.goto("/chats/g1");

    await page.getByTestId("thread-details").click();

    // The opener only asks — leaving cannot be undone from here.
    await page.getByTestId("group-leave").click();
    await expect(page.getByTestId("group-leave-prompt")).toBeVisible();
    expect(backend.left).toHaveLength(0);

    // Cancel really cancels: nothing is sent and the opener comes back.
    await page.getByTestId("group-leave-cancel").click();
    await expect(page.getByTestId("group-leave")).toBeVisible();
    expect(backend.left).toHaveLength(0);

    await page.getByTestId("group-leave").click();
    await page.getByTestId("group-leave-confirm").click();
    await expect.poll(() => backend.left.length).toBe(1);
    await expect(page).toHaveURL(/\/chats$/);
    await expect(page.getByTestId("conversation-row")).toHaveCount(0);
  });

  test("runs the same query again after a dialog is closed", async ({
    page,
  }) => {
    // Both search boxes feed one `distinctUntilChanged` stream, so the second
    // identical query was dropped while the results had already been cleared —
    // the list just stayed empty with no request and no error.
    await mockBackend(page, {
      conversations: [group()],
      directory: [
        ...directory,
        {
          ownerId: "google_fourth",
          email: "fourth@example.com",
          displayName: "Fourth Person",
          pictureUrl: "",
        },
      ],
    });
    await page.goto("/chats/g1");

    await page.getByTestId("thread-details").click();
    await page.getByTestId("group-add-open").click();
    await page.getByTestId("group-add-search").fill("person");
    // Only the non-member is offered here.
    await expect(page.getByTestId("group-add-result")).toHaveCount(1);

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("group-member")).toHaveCount(0);

    // The identical query in the other box must still reach the directory.
    await page.getByTestId("compose").click();
    await page.getByTestId("directory-search").fill("person");
    await expect(page.getByTestId("directory-result")).toHaveCount(3);
  });

  test("hides the admin controls from a plain member", async ({ page }) => {
    // The server answers 403 either way; this only keeps the UI from offering
    // an action that cannot work.
    await mockBackend(page, {
      conversations: [
        group({
          participants: [
            { ownerId: OWNER, role: "member", lastReadAt: null },
            { ownerId: OTHER, role: "admin", lastReadAt: null },
            { ownerId: THIRD, role: "member", lastReadAt: null },
          ],
        }),
      ],
      directory,
    });
    await page.goto("/chats/g1");

    await page.getByTestId("thread-details").click();
    await expect(page.getByTestId("group-member")).toHaveCount(3);
    await expect(page.getByTestId("group-rename-input")).toHaveCount(0);
    await expect(page.getByTestId("group-add-open")).toHaveCount(0);
    // Leaving stays available to everyone.
    await expect(page.getByTestId("group-leave")).toBeVisible();
  });

  test("opens details by tapping the header, not only the icon", async ({
    page,
  }) => {
    // WhatsApp, Telegram and Messenger all open group info from the header
    // itself; the icon button is the affordance, the header is the target.
    await mockBackend(page, { conversations: [group()], directory });
    await page.goto("/chats/g1");

    await page.getByTestId("thread-identity").click();
    await expect(page.getByTestId("group-member")).toHaveCount(3);
  });

  test("a direct thread's header is not a control", async ({ page }) => {
    await mockBackend(page, { directory });
    await page.goto("/chats/c1");

    await expect(page.getByTestId("thread-identity")).not.toHaveAttribute(
      "role",
      "button",
    );
  });

  test("names the sender in a group's list preview", async ({ page }) => {
    // A bare line of text in a five-person thread says nothing about who is
    // being replied to, which is why every mainstream client prefixes it.
    await mockBackend(page, { conversations: [group()], directory });
    await page.goto("/chats");

    await expect(page.getByTestId("conversation-row").first()).toContainText(
      "Them: first message",
    );
  });

  test("colours participant names, and differently from each other", async ({
    page,
  }) => {
    await mockBackend(page, {
      conversations: [group()],
      directory,
      messages: [
        message({ id: "m1", senderOwnerId: OTHER, body: "from them" }),
        message({
          id: "m2",
          senderOwnerId: THIRD,
          body: "from third",
          createdAt: "2026-09-08T10:01:00.000Z",
        }),
      ],
    });
    await page.goto("/chats/g1");

    const names = page.getByTestId("message-sender");
    await expect(names).toHaveCount(2);

    // The colour is the whole point, so assert the painted value — a class or
    // a data attribute would pass with no palette wired up at all.
    const colours = await names.evaluateAll((nodes) =>
      nodes.map((node) => getComputedStyle(node).color),
    );
    expect(new Set(colours).size).toBe(2);
    for (const colour of colours) {
      expect(colour).not.toBe("rgba(0, 0, 0, 0)");
    }
  });

  test("phrases the typing indicator for one, two and many", async ({
    page,
  }) => {
    // "A, B is typing…" is the default a joined list gives you, and a group is
    // exactly where it shows up.
    const backend = await mockBackend(page, {
      conversations: [group()],
      directory,
    });
    await page.goto("/chats/g1");
    await expect.poll(() => backend.socketOpened(), SOCKET_POLL).toBeTruthy();

    const typing = (ownerId: string) =>
      backend.push({
        t: "typing",
        d: {
          conversation_id: "g1",
          owner_id: ownerId,
          until: new Date(Date.now() + 8000).toISOString(),
        },
      });

    typing(OTHER);
    await expect(page.getByTestId("typing-indicator")).toContainText(
      "Them is typing",
    );

    typing(THIRD);
    await expect(page.getByTestId("typing-indicator")).toContainText(
      "are typing",
    );

    typing("google_fourth");
    await expect(page.getByTestId("typing-indicator")).toContainText(
      "Several people are typing",
    );
  });

  /**
   * Reported 2026-09-14 with a screenshot: a directory full of leftover test
   * accounts grew the compose dialog past the screen, so its title and the
   * Create button were both off-viewport and the whole dialog scrolled.
   */
  test("keeps a long picker inside the viewport and scrolls only the results", async ({
    page,
  }) => {
    const crowd = Array.from({ length: 40 }, (_, index) => ({
      ownerId: `google_person_${index}`,
      email: `person${index}@example.com`,
      displayName: `Person Number ${index}`,
      pictureUrl: "",
    }));
    await mockBackend(page, { directory: crowd });

    for (const size of [
      { width: 1280, height: 700 },
      { width: 400, height: 640 },
    ]) {
      await page.setViewportSize(size);
      await page.goto("/chats");
      await page.getByTestId("compose").click();
      await page.getByTestId("new-group").click();
      await page.getByTestId("directory-search").fill("person");
      await expect(page.getByTestId("directory-result").first()).toBeVisible();

      const dialog = page.locator(".p-dialog");
      const box = (await dialog.boundingBox())!;
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(size.height);

      // The commit action is the thing that must never be pushed off-screen.
      const create = (await page.getByTestId("group-create").boundingBox())!;
      expect(create.y + create.height).toBeLessThanOrEqual(size.height);

      // Nothing may paint over the dialog. `.messenger-content` sets
      // `position: relative; z-index: 1`, which is a stacking context — so the
      // mask's own z-index of 1101 counted for nothing and the app header at
      // z-index 10 covered the dialog's title and close button. A z-index
      // assertion would have passed throughout; only hit-testing the pixel
      // catches it.
      const topmost = await page.evaluate(() => {
        const header = document.querySelector(".p-dialog-header");
        if (!header) return "no-dialog";
        const rect = header.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.x + 8, rect.y + 8);
        return hit?.closest(".p-dialog") ? "dialog" : (hit?.tagName ?? "none");
      });
      expect(topmost).toBe("dialog");

      // …and the overflow has to land on the list, not on the dialog.
      const listScrolls = await page
        .getByTestId("directory-result")
        .first()
        .evaluate((node) => {
          const list = node.closest("ul")!;
          return list.scrollHeight > list.clientHeight + 1;
        });
      expect(listScrolls).toBe(true);
    }
  });

  test("falls back to member names for a group with no title", async ({
    page,
  }) => {
    // The compose dialog will not create one of these — a name is required —
    // but `messenger-service` accepts a null title, so anything made through
    // the API still has to render. The fallback leaves the viewer out: the
    // list answers "who is this with", and you are not news.
    await mockBackend(page, {
      conversations: [group({ title: null })],
      directory,
    });
    await page.goto("/chats/g1");

    await expect(page.getByTestId("thread-title")).toHaveText(
      "Them, Third Person",
    );
    // Two names, never one: that is what the two-other minimum buys, and it is
    // why the name can stay optional at all.
    expect(
      (await page.getByTestId("thread-title").innerText()).split(", ").length,
    ).toBeGreaterThanOrEqual(2);
  });

  test("clears a failed group action once the next one succeeds", async ({
    page,
  }) => {
    // The notice had no way back down: one 403 left the banner up for the rest
    // of the session, still claiming a failure that had since been fixed.
    await mockBackend(page, { conversations: [group()], directory });
    // Renaming answers 403 once, then succeeds.
    let attempts = 0;
    await page.route(
      /\/api\/messenger\/conversations\/[^/?]+(\?|$)/,
      async (route) => {
        if (route.request().method() !== "PATCH") return route.fallback();
        attempts += 1;
        if (attempts === 1) {
          return route.fulfill({
            status: 403,
            contentType: "application/json",
            body: JSON.stringify({ error: "Admin role required" }),
          });
        }
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ data: { ...group(), title: "Renamed" } }),
        });
      },
    );

    await page.goto("/chats/g1");
    await page.getByTestId("thread-details").click();

    await page.getByTestId("group-rename-input").fill("Nope");
    await page.getByTestId("group-rename-save").click();
    await expect(page.getByTestId("group-error")).toBeVisible();

    await page.getByTestId("group-rename-input").fill("Renamed");
    await page.getByTestId("group-rename-save").click();
    await expect(page.getByTestId("group-error")).toHaveCount(0);
  });

  test("a group offers a call button, now that calling is a mesh", async ({
    page,
  }) => {
    /*
     * The inverse of what this asserted until phase 3 slice 3, when calling
     * was 1:1 and realtime-service refused a group invite outright.
     *
     * There is deliberately no check here against the mesh's size limit:
     * `MAX_CALL_PARTICIPANTS` is realtime-service's configuration and this
     * client does not know it, so a copy here would be a second source of
     * truth that goes stale the day it is tuned. A conversation too big to
     * call is refused at invite time with a message naming both numbers.
     */
    await mockBackend(page, { conversations: [group()], directory });
    await page.goto("/chats/g1");

    await expect(page.getByTestId("thread-details")).toBeVisible();
    await expect(page.getByTestId("thread-call")).toBeVisible();
    await expect(page.getByTestId("thread-call-video")).toBeVisible();
  });
});
