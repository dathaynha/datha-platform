import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { storageStateFor } from "../mint-auth";

/**
 * A real 1:1 call between two browser contexts, against the **live** stack.
 *
 * This is the nightly tier, never a PR gate (`testing/e2e-testing-strategy.md`
 * and `products/messenger-architecture.md` § Testing). Unlike every other spec
 * here it mocks nothing: it needs api-gateway, realtime-service,
 * messenger-service, Postgres, NATS and coturn all up, and it needs the
 * gateway's own JWT secret, because the seeded token is verified for real:
 *
 *   E2E_JWT_SECRET=<api-gateway JWT_SECRET> \
 *     pnpm exec playwright test --project=calls
 *
 * Media is faked by Chrome (`--use-fake-device-for-media-stream`), so no
 * microphone is touched and the tone is deterministic.
 */

const GATEWAY = process.env["E2E_GATEWAY_URL"] ?? "http://localhost:8080";

/**
 * The **shell** (:4000), not the standalone remote (:4003).
 *
 * The exit criterion is "navigate to /chatbot mid-call", and that route only
 * exists in the shell — which is also the only place the header widget (and so
 * the call dock) is actually mounted by its host. Testing the remote alone
 * would prove the dock renders but not that it survives the navigation that
 * matters.
 */
const BASE_URL = process.env["E2E_CALLS_BASE_URL"] ?? "http://localhost:4000";

interface Identity {
  ownerId: string;
  email: string;
  name: string;
}

/**
 * A distinct identity pair **per test**, stable across runs.
 *
 * Module-level ids were shared by both tests, and because a direct
 * conversation is idempotent on the sorted pair they also shared the thread —
 * so `realtime-service` still held call state for those owners when the second
 * test invited, and the callee never rang (2026-09-10). The label gives each
 * test its own conversation and its own call state, which is what that fix
 * needed.
 *
 * It used to append `Date.now()` as well, making the pair unique per **run**.
 * That is not isolation, it is a leak: `contextFor` provisions each identity
 * into accounts-service and there is no delete, so every run left two more
 * people in the directory forever. By 2026-09-14 the New-message picker was a
 * wall of "E2E Callee" and real people could not be found (dathq, with a
 * screenshot). Test data that outlives the test is a product bug waiting to be
 * reported as one.
 *
 * The trade-off is that a run killed mid-call can leave Redis call state for
 * these owners, which the next run within `CALL_TTL_SECONDS` would meet. A
 * clean hangup deletes its own state, so this only bites after a hard kill —
 * cheap next to an unbounded directory.
 */
function freshPair(label: string): { caller: Identity; callee: Identity } {
  return {
    caller: {
      ownerId: `google_e2e_caller_${label}`,
      email: `caller_${label}@datha.local`,
      name: "E2E Caller",
    },
    callee: {
      ownerId: `google_e2e_callee_${label}`,
      email: `callee_${label}@datha.local`,
      name: "E2E Callee",
    },
  };
}

/**
 * The gateway's own secret, or `null` when this tier was not opted into.
 *
 * A bare `pnpm e2e` is the PR-gate command, and this suite is the nightly tier:
 * absent the secret it must report as **skipped**, not failed. Throwing here
 * turned every default run red on two specs that were never meant to run.
 */
function secretOrNull(): string | null {
  const value = process.env["E2E_JWT_SECRET"];
  // The placeholder from the mocked tiers signs tokens the real gateway rejects.
  return !value || value === "e2e-local-secret" ? null : value;
}

function secret(): string {
  const value = secretOrNull();
  if (!value) {
    throw new Error(
      "E2E_JWT_SECRET must be api-gateway's JWT_SECRET: this suite talks to the real gateway.",
    );
  }
  return value;
}

/** A signed-in context for one identity. */
async function contextFor(
  browser: Browser,
  identity: Identity,
): Promise<BrowserContext> {
  return browser.newContext({
    storageState: storageStateFor(identity, secret(), BASE_URL),
    permissions: ["microphone"],
  });
}

/** Creates the direct conversation through the gateway, as the app would. */
async function createConversation(
  page: Page,
  callee: Identity,
): Promise<string> {
  const response = await page.request.post(
    `${GATEWAY}/api/messenger/conversations`,
    {
      headers: { Authorization: await bearerOf(page) },
      data: { type: "direct", participant_owner_ids: [callee.ownerId] },
    },
  );
  expect(response.ok(), await response.text()).toBeTruthy();
  const body = (await response.json()) as { data: { id: string } };
  return body.data.id;
}

async function bearerOf(page: Page): Promise<string> {
  const token = await page.evaluate(() =>
    window.localStorage.getItem("access_token"),
  );
  return `Bearer ${token}`;
}

test.describe("a live 1:1 call", () => {
  test.skip(
    secretOrNull() === null,
    "nightly tier: set E2E_JWT_SECRET to api-gateway's JWT_SECRET to run it",
  );

  test("connects, survives navigation, and hangs up", async ({ browser }) => {
    const { caller: callerId, callee: calleeId } = freshPair("connects");
    const callerContext = await contextFor(browser, callerId);
    const calleeContext = await contextFor(browser, calleeId);
    const caller = await callerContext.newPage();
    const callee = await calleeContext.newPage();

    // Surface browser errors: a WebRTC failure often shows up only in console.
    for (const [name, page] of [
      ["caller", caller],
      ["callee", callee],
    ] as const) {
      page.on("console", (message) => {
        if (message.type() === "error") {
          console.log(`[${name}] ${message.text()}`);
        }
      });
    }

    await caller.goto("/messenger");
    await callee.goto("/messenger");

    const conversationId = await createConversation(caller, calleeId);

    // Both sides open the thread, so the socket has authorized it and the
    // callee's dock is mounted and listening.
    await caller.goto(`/messenger/chats/${conversationId}`);
    await callee.goto(`/messenger/chats/${conversationId}`);

    // Both sockets must be up before inviting. The call button is only
    // enabled while `connected()`, so asserting it on **each** side proves it
    // — and without the callee's, the server fans the ring out to an owner
    // subject nobody is listening on and the callee never rings (2026-09-10).
    await expect(caller.getByTestId("thread-call")).toBeEnabled({
      timeout: 20_000,
    });
    await expect(callee.getByTestId("thread-call")).toBeEnabled({
      timeout: 20_000,
    });

    await caller.getByTestId("thread-call").click();

    // The callee's dock rings without any navigation of its own.
    const calleeDock = callee.getByTestId("call-dock");
    await expect(calleeDock).toBeVisible({ timeout: 15_000 });
    await expect(callee.getByTestId("call-accept")).toBeVisible();

    await callee.getByTestId("call-accept").click();

    // `active` is ICE-connected, not merely signalled: the duration only
    // appears once media can actually flow.
    await expect(caller.getByTestId("call-duration")).toBeVisible({
      timeout: 30_000,
    });
    await expect(callee.getByTestId("call-duration")).toBeVisible();

    // The exit criterion: leaving Messenger must not drop the call. The dock is
    // mounted by the header widget, so client-side routing re-renders nothing
    // here and the RTCPeerConnection survives.
    //
    // Navigated by **clicking the shell's own link**, not `page.goto`. A
    // `goto` is a full document load: it tears down the whole SPA, the widget
    // and the peer connection with it, so the assertion below could never
    // pass and the criterion was never actually being tested (2026-09-10).
    //
    // Home, not /chatbot: that route mounts the chatbot **remote**, so with
    // :4001 stopped the shell shows "App Unavailable" and never leaves the
    // page. Home is shell-owned chrome, so this suite needs only the messenger
    // group running. The mechanism under test is identical — client-side
    // routing away from /messenger while a call is up.
    await caller.getByRole("link", { name: "Home" }).click();
    await expect(caller).toHaveURL(/localhost:4000\/$/);
    await expect(caller.getByTestId("call-dock")).toBeVisible();
    await expect(caller.getByTestId("call-duration")).toBeVisible();

    // Still *running*, not merely still rendered: a dock frozen at 0:04 would
    // satisfy a visibility check while the call was actually dead.
    const before = await caller.getByTestId("call-duration").textContent();
    await caller.waitForTimeout(2_500);
    const after = await caller.getByTestId("call-duration").textContent();
    expect(after).not.toEqual(before);

    await caller.getByTestId("call-hangup").click();

    // Both docks clear, and the callee is told why.
    await expect(caller.getByTestId("call-dock")).toBeHidden({
      timeout: 10_000,
    });
    await expect(callee.getByTestId("call-end-notice")).toBeVisible({
      timeout: 10_000,
    });

    await callerContext.close();
    await calleeContext.close();
  });

  test("a declined call tells the caller it was declined", async ({
    browser,
  }) => {
    const { caller: callerId, callee: calleeId } = freshPair("declined");
    const callerContext = await contextFor(browser, callerId);
    const calleeContext = await contextFor(browser, calleeId);
    const caller = await callerContext.newPage();
    const callee = await calleeContext.newPage();

    await caller.goto("/messenger");
    await callee.goto("/messenger");
    const conversationId = await createConversation(caller, calleeId);
    await caller.goto(`/messenger/chats/${conversationId}`);
    await callee.goto(`/messenger/chats/${conversationId}`);

    // Both sockets must be up before inviting. The call button is only
    // enabled while `connected()`, so asserting it on **each** side proves it
    // — and without the callee's, the server fans the ring out to an owner
    // subject nobody is listening on and the callee never rings (2026-09-10).
    await expect(caller.getByTestId("thread-call")).toBeEnabled({
      timeout: 20_000,
    });
    await expect(callee.getByTestId("thread-call")).toBeEnabled({
      timeout: 20_000,
    });
    await caller.getByTestId("thread-call").click();

    await expect(callee.getByTestId("call-dock")).toBeVisible({
      timeout: 15_000,
    });
    await callee.getByTestId("call-hangup").click();

    // "Declined" and "no answer" are different rows in someone's history, and
    // the whole reason the server distinguishes them is that a person sees it.
    const notice = caller.getByTestId("call-end-notice");
    await expect(notice).toBeVisible({ timeout: 10_000 });
    await expect(notice).toContainText("declined");

    await callerContext.close();
    await calleeContext.close();
  });
});

/**
 * A live **three-way** call across three browser contexts (phase 3 slice 3).
 *
 * Same tier and same requirements as the 1:1 suite above, and the same reason
 * for existing: a mesh is N-1 connections rather than one, and no unit suite
 * can see whether media actually arrives on each of them. The dock rendered at
 * the wrong width through 135 passing specs (2026-09-11), so the assertions
 * below measure the tiles rather than count their classes.
 */
function quartet(label: string): Identity[] {
  return ["a", "b", "c", "d"].map((slot) => ({
    ownerId: `google_e2e_${slot}_${label}`,
    email: `${slot}_${label}@datha.local`,
    name: `E2E ${slot.toUpperCase()}`,
  }));
}

/**
 * Finds this label's group, or creates it.
 *
 * Emphatically not "create one per run". A direct conversation is idempotent
 * on the sorted pair, so the 1:1 suite above can create freely; a group is a
 * first-class object and `POST /conversations` makes a new one every time.
 * Eight runs left eight identical "E2E Mesh" groups in the dev database
 * (2026-09-15) — test data that outlives the test, which is exactly how the
 * New-message picker filled up with "E2E Callee" and real people stopped being
 * findable. There is no conversation-delete endpoint to clean up with, so the
 * creation has to be idempotent instead.
 */
async function findOrCreateGroup(
  page: Page,
  others: Identity[],
  title: string,
): Promise<string> {
  const authorization = await bearerOf(page);
  const listing = await page.request.get(
    `${GATEWAY}/api/messenger/conversations`,
    { headers: { Authorization: authorization } },
  );
  expect(listing.ok(), await listing.text()).toBeTruthy();
  const { data } = (await listing.json()) as {
    data: { id: string; type: string; title: string | null }[];
  };
  const existing = data.find((c) => c.type === "group" && c.title === title);
  if (existing) return existing.id;

  const response = await page.request.post(
    `${GATEWAY}/api/messenger/conversations`,
    {
      headers: { Authorization: authorization },
      data: {
        type: "group",
        title,
        participant_owner_ids: others.map((o) => o.ownerId),
      },
    },
  );
  expect(response.ok(), await response.text()).toBeTruthy();
  const body = (await response.json()) as { data: { id: string } };
  return body.data.id;
}

/** Every people tile on this page, in render order, with its owner. */
async function tiles(page: Page): Promise<{ owner: string; box: DOMRect }[]> {
  return page.evaluate(() =>
    Array.from(
      document.querySelectorAll(
        "[data-testid='call-tile-peer'], [data-testid='call-tile-self']",
      ),
    ).map((element) => ({
      owner: (element as HTMLElement).dataset["owner"] ?? "",
      box: element.getBoundingClientRect().toJSON() as DOMRect,
    })),
  );
}

test.describe("a live group call", () => {
  test.skip(
    secretOrNull() === null,
    "nightly tier: set E2E_JWT_SECRET to api-gateway's JWT_SECRET to run it",
  );

  /*
   * Four people is the phase-3 exit criterion and also the mesh's cap
   * (`MAX_CALL_PARTICIPANTS`), so this is the call at its widest: twelve
   * directed media streams over six connections.
   */
  test("meshes four people, and one leaving does not end it", async ({
    browser,
  }) => {
    const people = quartet("mesh");
    const [, b, c, d] = people;
    const contexts = await Promise.all(
      people.map((identity) =>
        browser.newContext({
          storageState: storageStateFor(identity, secret(), BASE_URL),
          permissions: ["microphone", "camera"],
        }),
      ),
    );
    const pages = await Promise.all(
      contexts.map((context) => context.newPage()),
    );
    const [pageA, pageB, pageC, pageD] = pages;
    /** Each page paired with the identity it is signed in as. */
    const members = people.map((identity, at) => ({
      identity,
      page: pages[at],
    }));

    for (const { identity, page } of members) {
      page.on("console", (message) => {
        if (message.type() === "error")
          console.log(`[${identity.name}] ${message.text()}`);
      });
    }

    await Promise.all(pages.map((p) => p.goto("/messenger")));
    const conversationId = await findOrCreateGroup(
      pageA,
      [b, c, d],
      "E2E Mesh",
    );

    await Promise.all(
      pages.map((p) => p.goto(`/messenger/chats/${conversationId}`)),
    );

    // Every socket must be up before the invite: the ring is fanned out to
    // owner subjects, and core NATS is fire-and-forget, so a listener that is
    // not there yet simply never rings.
    for (const page of pages) {
      await expect(page.getByTestId("thread-call-video")).toBeEnabled({
        timeout: 20_000,
      });
    }

    await pageA.getByTestId("thread-call-video").click();

    for (const page of [pageB, pageC, pageD]) {
      await expect(page.getByTestId("call-dock")).toBeVisible({
        timeout: 15_000,
      });
      await page.getByTestId("call-accept").click();
    }

    // Active means ICE-connected, not merely signalled.
    for (const page of pages) {
      await expect(page.getByTestId("call-duration")).toBeVisible({
        timeout: 45_000,
      });
    }

    /*
     * The mesh itself. Three tiles per page — two others plus yourself — each
     * bound to its own owner, and every remote one actually painting frames.
     * `videoWidth` is the assertion that matters: class and testid checks pass
     * happily against a tile whose srcObject was never set, which is exactly
     * the bug that shipped on 2026-09-11.
     */
    for (const { identity: self, page } of members) {
      const rendered = await tiles(page);
      expect(rendered.map((t) => t.owner).sort()).toEqual(
        people.map((i) => i.ownerId).sort(),
      );
      /*
       * Measured, and measured against the stage. Three tiles in a
       * two-column grid used to leave one against an empty quadrant, and a
       * tile that overflows its stage is cut off with nothing to say so —
       * neither is visible to an assertion about classes or testids, which is
       * how the expanded dock shipped at the compact width through 135
       * passing specs (2026-09-11).
       */
      const stage = await page
        .getByTestId("call-stage")
        .evaluate((element) => element.getBoundingClientRect().toJSON());
      for (const tile of rendered) {
        const where = `${self.ownerId} tile ${tile.owner}`;
        expect(tile.box.width, `${where} width`).toBeGreaterThan(40);
        expect(tile.box.height, `${where} height`).toBeGreaterThan(40);
        expect(tile.box.right, `${where} right edge`).toBeLessThanOrEqual(
          stage.right + 1,
        );
        expect(tile.box.bottom, `${where} bottom edge`).toBeLessThanOrEqual(
          stage.bottom + 1,
        );
      }

      // Four faces tile two by two, so no row is short and nothing is centred.
      expect(rendered.length % 2, "an even grid needs no trailing row").toBe(0);
      const rows = new Set(rendered.map((t) => Math.round(t.box.top)));
      expect(rows.size, `${self.ownerId} lays four tiles in two rows`).toBe(2);

      const others = people.filter((i) => i.ownerId !== self.ownerId);
      for (const other of others) {
        /*
         * Polled, not sampled once. ICE connecting is what makes the duration
         * appear, and the first *video* frame lands a moment later — an
         * encoder start and a keyframe after the transport is up. Read
         * immediately this is 0 every time, which looks exactly like a broken
         * mesh and is not one.
         */
        await expect
          .poll(
            () =>
              page
                .locator(`[data-call-video][data-owner='${other.ownerId}']`)
                .evaluate((element) => {
                  const video = element as HTMLVideoElement;
                  return video.srcObject === null ? -1 : video.videoWidth;
                }),
            {
              timeout: 30_000,
              message: `${self.ownerId} sees frames from ${other.ownerId}`,
            },
          )
          .toBeGreaterThan(0);
      }
    }

    await pageA.screenshot({ path: "test-results/group-call-four-way.png" });

    /*
     * Leaving is not hanging up. In a 1:1 they are the same act; in a group C
     * going means one tile closing while A and B keep talking — and the
     * server only ends the call once it runs out of people.
     */
    await pageD.getByTestId("call-hangup").click();

    for (const page of [pageA, pageB, pageC]) {
      await expect
        .poll(async () => (await tiles(page)).length, { timeout: 15_000 })
        .toBe(3);
      await expect(page.getByTestId("call-duration")).toBeVisible();
    }
    await expect(pageD.getByTestId("call-dock")).toBeHidden();

    // Three faces now, so the trailing tile centres rather than sitting beside
    // an empty quadrant that reads as somebody who failed to connect.
    const afterLeave = await tiles(pageA);
    const stageA = await pageA
      .getByTestId("call-stage")
      .evaluate((element) => element.getBoundingClientRect().toJSON());
    const trailing = afterLeave[afterLeave.length - 1];
    expect(
      Math.abs(
        trailing.box.left +
          trailing.box.width / 2 -
          (stageA.left + stageA.width / 2),
      ),
      "the odd tile is centred",
    ).toBeLessThan(4);
    await pageA.screenshot({ path: "test-results/group-call-after-leave.png" });

    await pageC.getByTestId("call-hangup").click();
    await pageB.getByTestId("call-hangup").click();

    // And now it is spent: a mesh of one is a person looking at themselves, so
    // the server ends it rather than leaving A alone in a room.
    await expect(pageA.getByTestId("call-dock")).toBeHidden({
      timeout: 15_000,
    });

    for (const context of contexts) await context.close();
  });

  /*
   * The banner has to go when the call does — live, on the frame.
   *
   * dathq watched a call end and was still offered Join for it (2026-09-15).
   * Two causes, both about waiting for postgres: the history row is written by
   * a JetStream consumer, so it still read `ended_at: null` for a beat, and the
   * refetch meant to cover that waited for the row to be *present* — which it
   * had been since the call started, so it stopped on the first fetch and kept
   * the open row forever.
   *
   * This is a **bystander**: C never joins, so its banner is driven purely by
   * frames. Reloading the page would prove nothing here — a fresh load just
   * reads a closed row — which is exactly why this drives the live path.
   *
   * ⚠️ It is NOT the regression guard for that bug, and was checked rather than
   * assumed: reverted against the buggy code it still **passed**, because the
   * projection happened to land before the refetch and the row read as closed
   * anyway. It can only fail when the fetch wins that race, which is not
   * something to build a guard on. The deterministic proof is the unit spec
   * "takes the banner away the moment the call ends" in
   * `chat-store.service.spec.ts`, which fails with `Expected {…} to be null`.
   * What this test is worth is the whole path: decline, banner, end, banner
   * gone, with a real server and three browsers.
   */
  test("the ongoing-call banner goes when the call ends", async ({
    browser,
  }) => {
    const people = quartet("banner").slice(0, 3);
    const [, b, c] = people;
    const contexts = await Promise.all(
      people.map((identity) =>
        browser.newContext({
          storageState: storageStateFor(identity, secret(), BASE_URL),
          permissions: ["microphone", "camera"],
        }),
      ),
    );
    const pages = await Promise.all(
      contexts.map((context) => context.newPage()),
    );
    const [pageA, pageB, pageC] = pages;

    await Promise.all(pages.map((p) => p.goto("/messenger")));
    const conversationId = await findOrCreateGroup(pageA, [b, c], "E2E Banner");
    await Promise.all(
      pages.map((p) => p.goto(`/messenger/chats/${conversationId}`)),
    );
    for (const page of pages) {
      await expect(page.getByTestId("thread-call-video")).toBeEnabled({
        timeout: 20_000,
      });
    }

    await pageA.getByTestId("thread-call-video").click();

    // B answers; C lets it ring out and stays a bystander.
    await expect(pageB.getByTestId("call-dock")).toBeVisible({
      timeout: 15_000,
    });
    await pageB.getByTestId("call-accept").click();
    await expect(pageB.getByTestId("call-duration")).toBeVisible({
      timeout: 45_000,
    });

    // C declines the ring, and the call it did not join shows up as the banner.
    // Decline and hang-up are the same button — the dock relabels it, and the
    // server decides which act it was from the call's state.
    await expect(pageC.getByTestId("call-dock")).toBeVisible({
      timeout: 15_000,
    });
    await pageC.getByTestId("call-hangup").click();
    await expect(pageC.getByTestId("thread-live-call")).toBeVisible({
      timeout: 30_000,
    });
    // And the header stops offering to start a rival call while one is running.
    await expect(pageC.getByTestId("thread-call")).toBeHidden();

    // The call ends. Two hang-ups is one too many here — the second leaves
    // nobody, and the server ends it as `empty` — so one is enough.
    await pageB.getByTestId("call-hangup").click();
    await expect(pageA.getByTestId("call-dock")).toBeHidden({
      timeout: 20_000,
    });

    // The whole point: on the frame, not on the projection. The row still reads
    // `ended_at: null` for a beat after this, and the banner must already be
    // gone — otherwise Join points at a call that no longer exists.
    await expect(pageC.getByTestId("thread-live-call")).toBeHidden({
      timeout: 10_000,
    });
    await expect(pageC.getByTestId("thread-call")).toBeVisible();

    for (const context of contexts) await context.close();
  });

  /*
   * Coming back to a call after a reload — by pressing Join, not by magic.
   *
   * Auto-rejoin was built first and deleted on the same day: it needed an open
   * socket, reacquired capture and a won takeover, and failed silently when any
   * one of them did not. Three failure modes were fixed and it still dropped
   * dathq, whose answer was the product's own convention — Messenger shows the
   * ongoing call in the chat and you press Join. The half of this test that
   * matters most is the *first* assertion: nothing rejoins on its own.
   */
  test("a reloaded tab joins the ongoing call from the thread", async ({
    browser,
  }) => {
    const people = quartet("reload").slice(0, 3);
    const [, b, c] = people;
    const contexts = await Promise.all(
      people.map((identity) =>
        browser.newContext({
          storageState: storageStateFor(identity, secret(), BASE_URL),
          permissions: ["microphone", "camera"],
        }),
      ),
    );
    const pages = await Promise.all(
      contexts.map((context) => context.newPage()),
    );
    const [pageA, pageB, pageC] = pages;

    await Promise.all(pages.map((p) => p.goto("/messenger")));
    const conversationId = await findOrCreateGroup(pageA, [b, c], "E2E Reload");
    await Promise.all(
      pages.map((p) => p.goto(`/messenger/chats/${conversationId}`)),
    );
    for (const page of pages) {
      await expect(page.getByTestId("thread-call-video")).toBeEnabled({
        timeout: 20_000,
      });
    }

    // A video call, so there are tiles to count: an audio call renders no
    // stage at all, and `tiles()` would be 0 for everyone throughout.
    await pageA.getByTestId("thread-call-video").click();
    for (const page of [pageB, pageC]) {
      await expect(page.getByTestId("call-dock")).toBeVisible({
        timeout: 15_000,
      });
      await page.getByTestId("call-accept").click();
    }
    for (const page of pages) {
      await expect(page.getByTestId("call-duration")).toBeVisible({
        timeout: 45_000,
      });
    }

    // Somebody already in the call is never offered a way into it.
    await expect(pageB.getByTestId("thread-live-call")).toBeHidden();

    // A reloads. Its socket closes, realtime-service takes it out of the call
    // and tells the others; B and C keep talking.
    await pageA.reload();

    // The banner, and *only* the banner: a reloaded tab is out of the call
    // until its owner says otherwise.
    await expect(pageA.getByTestId("thread-live-call")).toBeVisible({
      timeout: 30_000,
    });
    await expect(pageA.getByTestId("call-dock")).toBeHidden();

    await pageA.getByTestId("thread-join-call").click();

    await expect(pageA.getByTestId("call-dock")).toBeVisible({
      timeout: 20_000,
    });
    await expect(pageA.getByTestId("call-duration")).toBeVisible({
      timeout: 45_000,
    });
    // Back in, so there is nothing left to join.
    await expect(pageA.getByTestId("thread-live-call")).toBeHidden();

    // And the others have it back as a peer, not as a tile that went away.
    for (const page of [pageB, pageC]) {
      await expect
        .poll(async () => (await tiles(page)).length, { timeout: 30_000 })
        .toBe(3);
    }
    expect((await tiles(pageA)).map((t) => t.owner).sort()).toEqual(
      people.map((i) => i.ownerId).sort(),
    );

    /*
     * Two hang-ups, not three. The second leaves one person in the room, and a
     * mesh of one is a person looking at themselves — so realtime-service ends
     * the call itself with `empty` rather than waiting for the last button.
     * Clicking a third time waits forever for a dock that is already gone.
     */
    await pageB.getByTestId("call-hangup").click();
    await pageC.getByTestId("call-hangup").click();
    await expect(pageA.getByTestId("call-dock")).toBeHidden({
      timeout: 15_000,
    });

    for (const context of contexts) await context.close();
  });
});
