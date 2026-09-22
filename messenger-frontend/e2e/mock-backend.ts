import type { Page, Route } from "@playwright/test";

/**
 * The mocked gateway every standalone chat spec runs against.
 *
 * Extracted from `specs/chat.spec.ts` when the group suite needed the same
 * fixtures: two copies of a 150-line mock is two things to keep in step, and
 * the one that drifts is always the copy nobody is currently editing.
 *
 * Every glob ends in `*`: the app appends `?culture=…`, and a pattern without
 * it silently fails to match — the request escapes to the real gateway and the
 * feature just never initialises.
 */

export const OWNER = "google_e2e-test-user"; // the id global-setup seeds
export const OTHER = "google_them";

export const message = (overrides: Record<string, unknown> = {}) => ({
  id: "m1",
  conversationId: "c1",
  senderOwnerId: OTHER,
  kind: "text",
  body: "first message",
  attachmentFileId: null,
  clientMessageId: "cm1",
  createdAt: "2026-09-08T10:00:00.000Z",
  editedAt: null,
  ...overrides,
});

export const conversation = (overrides: Record<string, unknown> = {}) => ({
  id: "c1",
  tenantId: "datha-platform",
  type: "direct",
  title: null,
  createdBy: OWNER,
  createdAt: "2026-09-08T09:00:00.000Z",
  lastMessageAt: "2026-09-08T10:00:00.000Z",
  // The list sorts on this, not on lastMessageAt. Untyped fixture, so nothing
  // would have caught its absence except a list that quietly stopped sorting.
  lastActivityAt: "2026-09-08T10:00:00.000Z",
  participants: [
    { ownerId: OWNER, role: "admin", lastReadAt: null },
    { ownerId: OTHER, role: "member", lastReadAt: null },
  ],
  lastMessage: message(),
  lastCall: null,
  unread: false,
  ...overrides,
});

export const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });

export interface MockOptions {
  conversations?: unknown[];
  messages?: unknown[];
  directory?: unknown[];
}

/** Mocks the socket, the token mint and every messenger/accounts endpoint. */
export async function mockBackend(page: Page, options: MockOptions = {}) {
  const conversations = options.conversations ?? [conversation()];
  const messages = options.messages ?? [message()];
  const posted: Record<string, unknown>[] = [];
  const sentFrames: string[] = [];
  let socket: import("@playwright/test").WebSocketRoute | null = null;

  await page.routeWebSocket(/\/api\/realtime\/ws/, (ws) => {
    socket = ws;
    ws.onMessage((frame) => sentFrames.push(String(frame)));
  });

  await page.route("**/api/realtime/token*", (route) =>
    json(route, { stream_token: "e2e-token", expires_in: 90 }),
  );
  await page.route("**/api/messenger/conversations/unread*", (route) =>
    json(route, { data: { conversation_ids: [] } }),
  );
  // The real `hydratePeople` resolves every participant, so the mock answers
  // for the whole directory too — with only one person in it, a group rendered
  // raw `google_…` ids for everybody else and hid the names under test.
  await page.route("**/api/accounts/users/lookup*", (route) =>
    json(route, {
      data: [
        // The signed-in user is looked up too: a group's member list names
        // everyone in it, this user included.
        {
          ownerId: OWNER,
          email: "e2e@example.com",
          displayName: "E2E Tester",
          pictureUrl: "",
        },
        {
          ownerId: OTHER,
          email: "them@example.com",
          displayName: "Them",
          pictureUrl: "",
        },
        ...(options.directory ?? []).filter(
          (person) => (person as { ownerId: string }).ownerId !== OTHER,
        ),
      ],
    }),
  );
  await page.route("**/api/accounts/users?*", (route) =>
    json(route, { data: options.directory ?? [] }),
  );
  await page.route("**/api/messenger/conversations/*/messages*", (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      posted.push(body);
      return json(
        route,
        {
          data: message({
            id: `server-${posted.length}`,
            senderOwnerId: OWNER,
            body: String(body["body"] ?? ""),
            clientMessageId: String(body["client_message_id"] ?? ""),
            createdAt: new Date().toISOString(),
          }),
        },
        201,
      );
    }
    // messenger-service pages backwards through the thread
    // (`ORDER BY created_at DESC`) and the client reverses for display, so a
    // mock handing them over oldest-first renders the whole thread upside
    // down. Sorting here means a spec can list them in either order.
    const newestFirst = [...messages].sort(
      (a, b) =>
        Date.parse((b as { createdAt: string }).createdAt) -
        Date.parse((a as { createdAt: string }).createdAt),
    );
    return json(route, { data: newestFirst, meta: { next_cursor: null } });
  });
  await page.route("**/api/messenger/conversations/*/read*", (route) =>
    json(route, { data: { last_read_at: "2026-09-08T10:00:00.000Z" } }),
  );
  // Group membership. Registered before the by-id route below because the
  // regex there also matches these URLs, and Playwright tries the most
  // recently registered handler first — so this one has to be older, not newer.
  await page.route(
    /\/api\/messenger\/conversations\/[^/?]+\/participants/,
    (route) => {
      const request = route.request();
      if (request.method() === "DELETE") {
        left.push(request.url());
        // The server stops returning a conversation you have left, and the
        // list is refetched when the page remounts on the way back to /chats
        // — so a static array here would hand the row straight back.
        const id = request.url().split("/conversations/")[1]?.split("/")[0];
        const index = conversations.findIndex(
          (candidate) => (candidate as { id: string }).id === id,
        );
        if (index >= 0) conversations.splice(index, 1);
        return route.fulfill({ status: 204, body: "" });
      }
      const body = request.postDataJSON() as { owner_ids: string[] };
      added.push(body);
      const existing = ((conversations[0] as { participants?: unknown[] })
        ?.participants ?? []) as { ownerId: string }[];
      return json(route, {
        data: [
          ...existing,
          ...body.owner_ids.map((ownerId) => ({
            ownerId,
            role: "member",
            lastReadAt: null,
          })),
        ],
      });
    },
  );

  // A single conversation by id: the store asks for one it does not have yet,
  // so opening a thread by URL never depends on the list having loaded first.
  await page.route(/\/api\/messenger\/conversations\/[^/?]+(\?|$)/, (route) => {
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON() as { title: string | null };
      renamed.push(body);
      const id =
        route.request().url().split("/conversations/")[1]?.split(/[?#]/)[0] ??
        "c1";
      const known = conversations.find(
        (candidate) => (candidate as { id: string }).id === id,
      );
      return json(route, {
        data: { ...(known ?? conversation({ id })), title: body.title },
      });
    }
    const url = route.request().url();
    const id = url.split("/conversations/")[1]?.split(/[?#]/)[0] ?? "c1";
    const known = conversations.find(
      (candidate) => (candidate as { id: string }).id === id,
    );
    return json(route, { data: known ?? conversation({ id }) });
  });

  await page.route("**/api/messenger/conversations*", (route) => {
    if (route.request().method() === "POST") {
      conversationCreates.push(route.request().postDataJSON());
      return json(route, { data: conversation({ id: "c-new" }) }, 201);
    }
    return json(route, { data: conversations, meta: { next_cursor: null } });
  });

  const conversationCreates: unknown[] = [];
  const added: { owner_ids: string[] }[] = [];
  const renamed: { title: string | null }[] = [];
  const left: string[] = [];
  const uploads: string[] = [];
  const prepared: Record<string, unknown>[] = [];
  await page.route("**/api/files/prepare*", (route) => {
    uploads.push("prepare");
    prepared.push(route.request().postDataJSON() as Record<string, unknown>);
    return json(
      route,
      {
        // A distinct id per call, so an original and its thumbnail are told
        // apart in the message that references them.
        fileId: `file-${prepared.length}`,
        // Mocked so the PUT stays inside the page: no Azure, no network.
        sasUploadUrl: "https://blob.example.test/spec.pdf?sig=e2e",
      },
      201,
    );
  });
  await page.route("https://blob.example.test/**", (route) => {
    uploads.push("blob-put");
    return route.fulfill({ status: 201, body: "" });
  });
  await page.route("**/api/files/*/confirm*", (route) => {
    uploads.push("confirm");
    return json(route, { id: "file-1", name: "spec.pdf", status: "uploaded" });
  });
  await page.route("**/messages/*/attachment*", (route) =>
    json(route, {
      data: {
        name: "spec.pdf",
        download_url: "https://blob.example.test/spec.pdf?sig=download",
        expires_at: "2026-09-08T10:05:00.000Z",
      },
    }),
  );

  return {
    posted,
    sentFrames,
    uploads,
    prepared,
    conversationCreates,
    added,
    renamed,
    left,
    push: (frame: Record<string, unknown>) => {
      if (!socket) throw new Error("the socket has not been opened yet");
      socket.send(JSON.stringify(frame));
    },
    socketOpened: () => socket !== null,
  };
}
