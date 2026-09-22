import { effect, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { OAuthService } from "angular-oauth2-oidc";
import { provideHttpClient } from "@angular/common/http";
import {
  HttpTestingController,
  provideHttpClientTesting,
} from "@angular/common/http/testing";
import { Subject } from "rxjs";
import { environment } from "src/environments/environment";
import type { Conversation, Message } from "src/models/messenger.model";
import { ChatStore } from "./chat-store.service";
import { FileUploadService } from "./file-upload.service";
import { RealtimeService, type RealtimeFrame } from "./realtime.service";
import { WebrtcCallService } from "./webrtc-call.service";
import type { CallRecord, LiveCall } from "src/models/call.model";

const OWNER = "google_me";
const CONVERSATION_ID = "c1";

/** An unsigned JWT carrying just the claim the store reads. */
function accessTokenFor(sub: string): string {
  const body = btoa(JSON.stringify({ sub })).replace(/=+$/, "");
  return `header.${body}.signature`;
}
const OTHER = "google_them";

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: "m1",
    conversationId: "c1",
    senderOwnerId: OTHER,
    kind: "text",
    body: "hey",
    attachmentFileId: null,
    clientMessageId: "cm1",
    createdAt: "2026-09-08T10:00:00.000Z",
    editedAt: null,
    ...overrides,
  };
}

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "c1",
    tenantId: "datha-platform",
    type: "direct",
    title: null,
    createdBy: OWNER,
    createdAt: "2026-09-08T09:00:00.000Z",
    lastMessageAt: "2026-09-08T10:00:00.000Z",
    lastActivityAt: "2026-09-08T10:00:00.000Z",
    participants: [
      { ownerId: OWNER, role: "admin", lastReadAt: null },
      { ownerId: OTHER, role: "member", lastReadAt: null },
    ],
    lastMessage: message(),
    lastCall: null,
    unread: true,
    ...overrides,
  };
}

/** Stands in for the blob upload: resolves, or fails on demand. */
class FakeUploads {
  attempts = 0;
  failTimes = 0;

  upload(_file: File): Promise<string> {
    this.attempts += 1;
    if (this.attempts <= this.failTimes) {
      return Promise.reject(new Error("blob upload failed"));
    }
    return Promise.resolve(`file-${this.attempts}`);
  }
}

/** Stands in for the socket: frames are pushed, calls are recorded. */
class FakeRealtime {
  readonly frames$ = new Subject<RealtimeFrame>();
  readonly opened: string[] = [];
  readonly closed: string[] = [];
  readonly typingStarts: string[] = [];
  readonly readMarks: string[] = [];
  readonly presenceSubscriptions: string[][] = [];

  typingEntries: { conversationId: string; ownerId: string; until: number }[] =
    [];
  typing = () => this.typingEntries;
  presence = () => new Map();
  connected = () => true;

  start(): void {}
  openConversation(id: string): void {
    this.opened.push(id);
  }
  closeConversation(id: string): void {
    this.closed.push(id);
  }
  startTyping(id: string): void {
    this.typingStarts.push(id);
  }
  stopTyping(): void {}
  markConversationRead(id: string): void {
    this.readMarks.push(id);
  }
  subscribePresence(ownerIds: string[]): void {
    this.presenceSubscriptions.push(ownerIds);
  }
}

/** Stands in for the call service: only the live call signal is read. */
class FakeCalls {
  private readonly live = signal<LiveCall | null>(null);
  readonly call = this.live.asReadonly();

  start(conversationId: string, callId: string): void {
    this.live.set({
      callId,
      conversationId,
      participantIds: [OWNER, OTHER],
      callerOwnerId: OWNER,
      joinedIds: [OWNER, OTHER],
      direction: "outgoing",
      media: "audio",
      state: "active",
      micMuted: false,
      cameraOff: false,
      cameraMissing: false,
      sharingScreen: false,
      micSilent: false,
      sendingVideo: false,
      activeSince: Date.now(),
      relayAvailable: true,
    });
  }

  end(): void {
    this.live.set(null);
  }
}

function callRecord(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    id: "call-1",
    conversationId: CONVERSATION_ID,
    callerOwnerId: OWNER,
    calleeOwnerId: OTHER,
    participantOwnerIds: [OWNER, OTHER],
    joinedOwnerIds: [OWNER, OTHER],
    media: "audio",
    status: "completed",
    startedAt: "2026-09-08T10:05:00.000Z",
    answeredAt: "2026-09-08T10:05:04.000Z",
    endedAt: "2026-09-08T10:09:16.000Z",
    endReason: "hangup",
    durationSeconds: 252,
    ...overrides,
  };
}

describe("ChatStore", () => {
  let store: ChatStore;
  let http: HttpTestingController;
  let realtime: FakeRealtime;
  let uploads: FakeUploads;
  let calls: FakeCalls;
  const base = environment.gateway.baseUrl;

  beforeEach(() => {
    realtime = new FakeRealtime();
    uploads = new FakeUploads();
    calls = new FakeCalls();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: RealtimeService, useValue: realtime },
        { provide: FileUploadService, useValue: uploads },
        { provide: WebrtcCallService, useValue: calls },
        // The store resolves the owner id from the access token; these specs
        // set it explicitly instead, so the token just has to be absent.
        { provide: OAuthService, useValue: { getAccessToken: () => null } },
      ],
    });
    store = TestBed.inject(ChatStore);
    http = TestBed.inject(HttpTestingController);
    store.setOwnerId(OWNER);
  });

  /**
   * Each step of a load is a separate request issued only after the previous
   * promise settles, so a test has to yield the microtask queue before the next
   * request exists. Flushing too early matches nothing and the await never
   * resolves — which shows up as a spec timeout, not as a missing request.
   */
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  const flushConversations = async (conversations: Conversation[]) => {
    await settle();
    http
      .expectOne((request) => request.url === `${base}/conversations`)
      .flush({ data: conversations });
  };

  const flushLookup = async () => {
    await settle();
    const pending = http.match((request) =>
      request.url.includes("/users/lookup"),
    );
    for (const request of pending) {
      request.flush({
        data: [
          {
            ownerId: OTHER,
            email: "them@example.com",
            displayName: "Them",
            pictureUrl: "",
          },
        ],
      });
    }
  };

  const flushMessages = async (conversationId: string, messages: Message[]) => {
    await settle();
    // Opening a thread the list does not contain asks for it by id first, so
    // that request — and the directory lookup behind it — is answered here.
    const detail = http.match(
      (request) =>
        request.method === "GET" &&
        request.url === `${base}/conversations/${conversationId}`,
    );
    for (const request of detail) {
      request.flush({ data: conversation({ id: conversationId }) });
    }
    if (detail.length > 0) {
      await settle();
      for (const request of http.match((r) =>
        r.url.includes("/users/lookup"),
      )) {
        request.flush({ data: [] });
      }
      await settle();
    }
    http
      .expectOne(
        (request) =>
          request.url === `${base}/conversations/${conversationId}/messages` &&
          request.method === "GET",
      )
      .flush({ data: messages, meta: { next_cursor: null } });
  };

  const flushCalls = async (conversationId: string, records: CallRecord[]) => {
    await settle();
    http
      .expectOne(
        (request) =>
          request.method === "GET" &&
          request.url === `${base}/conversations/${conversationId}/calls`,
      )
      .flush({ data: records });
  };

  const flushRead = async (conversationId: string, lastReadAt: string) => {
    await settle();
    http
      .expectOne(`${base}/conversations/${conversationId}/read`)
      .flush({ data: { last_read_at: lastReadAt } });
  };

  const flushPost = async (
    conversationId: string,
    respond: (clientMessageId: string) => Message | "error",
  ) => {
    await settle();
    const posted = http.expectOne(
      (request) =>
        request.method === "POST" &&
        request.url === `${base}/conversations/${conversationId}/messages`,
    );
    const clientMessageId = (
      posted.request.body as { client_message_id: string }
    ).client_message_id;
    const answer = respond(clientMessageId);
    if (answer === "error") {
      posted.error(new ProgressEvent("network"));
    } else {
      posted.flush({ data: answer });
    }
    return clientMessageId;
  };

  it("loads conversations and resolves participant names", async () => {
    const loading = store.loadConversations();
    await flushConversations([conversation()]);
    await flushLookup();
    await loading;

    expect(store.conversations().length).toBe(1);
    expect(store.displayName(OTHER)).toBe("Them");
    // Presence is subscribed only for the owners actually on screen.
    expect(realtime.presenceSubscriptions.at(-1)).toEqual([OTHER]);
  });

  it("titles a direct conversation with the other person", async () => {
    const loading = store.loadConversations();
    await flushConversations([conversation()]);
    await flushLookup();
    await loading;

    expect(store.conversationTitle(store.conversations()[0])).toBe("Them");
  });

  it("takes the owner id from the access token, not the id_token", async () => {
    // api-gateway mints the access token with `sub = "google_<sub>"` and leaves
    // the provider's id_token untouched, so the id_token's `sub` matches no
    // participant. Reading it left the store believing it was nobody, and
    // "which of these two is me?" answered "neither" — both people saw the
    // same name on a direct conversation (2026-09-10).
    TestBed.resetTestingModule();
    const token = accessTokenFor(OWNER);
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: RealtimeService, useValue: realtime },
        { provide: FileUploadService, useValue: uploads },
        { provide: OAuthService, useValue: { getAccessToken: () => token } },
      ],
    });
    const scoped = TestBed.inject(ChatStore);
    const scopedHttp = TestBed.inject(HttpTestingController);

    // Deliberately no setOwnerId: resolving it is the store's own job.
    scoped.syncOwnerId();
    expect(scoped.currentOwnerId()).toBe(OWNER);
    expect(scoped.conversationTitle(conversation())).toBe(OTHER);
    scopedHttp.verify();
  });

  it("does not show this user their own typing indicator", async () => {
    const loading = store.loadConversations();
    await flushConversations([conversation()]);
    await flushLookup();
    await loading;
    const opening = store.openConversation(CONVERSATION_ID);
    await flushMessages(CONVERSATION_ID, [message()]);
    await flushRead(CONVERSATION_ID, "2026-09-08T10:00:00.000Z");
    await opening;

    // realtime-service fans typing out to the whole conversation, sender
    // included; without the self filter you watch yourself type.
    realtime.typingEntries = [
      {
        conversationId: CONVERSATION_ID,
        ownerId: OWNER,
        until: Date.now() + 5_000,
      },
      {
        conversationId: CONVERSATION_ID,
        ownerId: OTHER,
        until: Date.now() + 5_000,
      },
    ];

    expect(store.typistsOf(CONVERSATION_ID)).toEqual([OTHER]);
  });

  it("re-marks a thread read when the user comes back to it", async () => {
    // Reported 2026-09-10: a message arriving while the window was in the
    // background stayed unread while you clicked in, focused the box and
    // typed. Only sending cleared it, because `document.hasFocus()` was
    // checked once on arrival and nothing ever re-checked.
    const loading = store.loadConversations();
    await flushConversations([conversation()]);
    await flushLookup();
    await loading;
    const opening = store.openConversation(CONVERSATION_ID);
    await flushMessages(CONVERSATION_ID, [message()]);
    await flushRead(CONVERSATION_ID, "2026-09-08T10:00:00.000Z");
    await opening;

    // A message lands while the window is elsewhere: nothing is marked.
    spyOn(document, "hasFocus").and.returnValue(false);
    realtime.frames$.next({
      t: "message.new",
      d: {
        conversation_id: CONVERSATION_ID,
        message: message({ id: "m2", body: "you there?" }),
      },
    });
    await settle();
    http
      .match((r) => r.url.includes(`/conversations/${CONVERSATION_ID}/read`))
      .forEach(() => fail("marked read while the window was not focused"));

    // Coming back — focusing the composer, typing — is what was missing.
    store.markActiveRead();
    await settle();
    const marked = http.match((r) =>
      r.url.includes(`/conversations/${CONVERSATION_ID}/read`),
    );
    expect(marked.length).toBe(1);
    expect(marked[0]!.request.body).toEqual({ message_id: "m2" });
    marked[0]!.flush({ data: { last_read_at: "2026-09-08T10:03:00.000Z" } });
  });

  it("does not re-post the same read watermark", async () => {
    // markActiveRead is wired to focus and to typing, so it runs constantly.
    const loading = store.loadConversations();
    await flushConversations([conversation()]);
    await flushLookup();
    await loading;
    const opening = store.openConversation(CONVERSATION_ID);
    await flushMessages(CONVERSATION_ID, [message()]);
    await flushRead(CONVERSATION_ID, "2026-09-08T10:00:00.000Z");
    await opening;

    store.markActiveRead();
    store.markActiveRead();
    store.markActiveRead();
    await settle();

    expect(
      http.match((r) =>
        r.url.includes(`/conversations/${CONVERSATION_ID}/read`),
      ).length,
    ).toBe(0);
  });

  it("keeps an inbound message that lands while the first page is loading", async () => {
    // The mirror of the case below, on the receiving side. Found 2026-09-10 by
    // a read-receipt spec that failed 2 runs in 12 with the thread holding
    // only its original message: `appendToThread` drops frames for a thread
    // with no page, and the page — already requested — could never contain it.
    const loading = store.loadConversations();
    await flushConversations([conversation()]);
    await flushLookup();
    await loading;

    // Open the thread but leave its page in flight.
    const opening = store.openConversation(CONVERSATION_ID);
    await settle();

    realtime.frames$.next({
      t: "message.new",
      d: {
        conversation_id: CONVERSATION_ID,
        // A distinct client id: the fixture defaults to one, and the merge
        // dedupes on it exactly as it must in production.
        message: message({
          id: "inbound-1",
          clientMessageId: "cm-inbound-1",
          body: "landed mid-load",
          createdAt: "2026-09-08T10:05:00.000Z",
        }),
      },
    });
    await settle();
    expect(store.messagesOf(CONVERSATION_ID).map((m) => m.body)).toContain(
      "landed mid-load",
    );

    await flushMessages(CONVERSATION_ID, [
      message({
        id: "old",
        body: "hey",
        createdAt: "2026-09-08T10:00:00.000Z",
      }),
    ]);
    await flushRead(CONVERSATION_ID, "2026-09-08T10:00:00.000Z");
    await opening;

    expect(store.messagesOf(CONVERSATION_ID).map((m) => m.body)).toEqual([
      "hey",
      "landed mid-load",
    ]);
  });

  it("keeps a message sent while the first page is still loading", async () => {
    // Found 2026-09-10 via an attachment spec that only failed under load: the
    // sidebar showed the file as the latest message while the thread never
    // contained it. `appendToThread` drops rows for a thread with no page —
    // right for an inbound frame, wrong for the user's own send — and the
    // fetched page cannot contain a message that did not exist when it was
    // requested.
    const loading = store.loadConversations();
    await flushConversations([conversation()]);
    await flushLookup();
    await loading;

    // Open the thread but leave the message page in flight.
    const opening = store.openConversation(CONVERSATION_ID);
    await settle();

    // The user sends while it is still loading.
    const sending = store.sendMessage(CONVERSATION_ID, "beat the page");
    await settle();
    expect(store.messagesOf(CONVERSATION_ID).map((m) => m.body)).toContain(
      "beat the page",
    );

    // Now the page — requested before that message existed — lands.
    await flushMessages(CONVERSATION_ID, [message({ id: "old", body: "hey" })]);
    await flushRead(CONVERSATION_ID, "2026-09-08T10:00:00.000Z");
    await opening;

    // Both are there, oldest first, and the optimistic row survived.
    expect(store.messagesOf(CONVERSATION_ID).map((m) => m.body)).toEqual([
      "hey",
      "beat the page",
    ]);

    http
      .match((r) =>
        r.url.includes(`/conversations/${CONVERSATION_ID}/messages`),
      )
      .forEach((r) =>
        r.flush({
          data: message({ id: "server-1", body: "beat the page" }),
        }),
      );
    await sending;
  });

  it("falls back to the owner id when the directory is unavailable", async () => {
    const loading = store.loadConversations();
    await flushConversations([conversation()]);
    await settle();
    http
      .match((request) => request.url.includes("/users/lookup"))
      .forEach((request) => request.error(new ProgressEvent("network")));
    await loading;

    // Names degrade, the thread still works.
    expect(store.conversationTitle(store.conversations()[0])).toBe(OTHER);
  });

  /**
   * The call dock asks for every participant in an `effect`, and
   * `ensurePerson` reads the directory as its own guard. A fresh Map on a
   * lookup that resolved nobody made the signal emit anyway, so that effect
   * re-ran, asked again, and emitted again — 2187 requests in three seconds
   * against a mocked gateway (2026-09-17). It needs an owner the directory
   * cannot resolve, which is a real case: a deleted account, or someone who
   * has never signed in.
   */
  it("does not emit a directory change when a lookup resolves nobody", async () => {
    // Counts emissions of the directory signal, which is what the dock's
    // effect is really reacting to — read through the public accessor, since
    // that is how every consumer touches it.
    let runs = 0;
    TestBed.runInInjectionContext(() => {
      effect(() => {
        store.displayName("google_ghost");
        runs += 1;
      });
    });
    TestBed.tick();
    expect(runs).toBe(1);

    const lookup = store.ensurePerson("google_ghost");
    http
      .match((request) => request.url.includes("/users/lookup"))
      .forEach((request) => request.flush({ data: [] }));
    await lookup;
    TestBed.tick();

    // Still one: the directory learned nothing, so nothing downstream of it
    // had any reason to recompute — let alone ask again.
    expect(runs).toBe(1);
  });

  it("opens a thread, authorizes the socket and marks it read", async () => {
    const loading = store.loadConversations();
    await flushConversations([conversation()]);
    await flushLookup();
    await loading;

    const opening = store.openConversation("c1");
    await flushMessages("c1", [message()]);
    await flushRead("c1", "2026-09-08T10:00:00.000Z");
    await opening;

    expect(realtime.opened).toContain("c1");
    expect(realtime.readMarks).toContain("c1");
    expect(store.messagesOf(CONVERSATION_ID).length).toBe(1);
    expect(store.conversations()[0].unread).toBeFalse();
  });

  it("renders the thread oldest first", async () => {
    const older = message({
      id: "m-old",
      createdAt: "2026-09-08T09:30:00.000Z",
    });
    const newer = message({
      id: "m-new",
      createdAt: "2026-09-08T10:00:00.000Z",
    });

    const opening = store.openConversation("c1");
    // The API answers newest first.
    await flushMessages("c1", [newer, older]);
    await flushRead("c1", newer.createdAt);
    await opening;

    expect(store.messagesOf(CONVERSATION_ID).map((m) => m.id)).toEqual([
      "m-old",
      "m-new",
    ]);
  });

  it("sends optimistically, then reconciles on the client message id", async () => {
    const opening = store.openConversation("c1");
    await flushMessages("c1", []);
    await opening;

    const sending = store.sendMessage("c1", "hello there");
    // Rendered before the server has answered.
    expect(store.messagesOf(CONVERSATION_ID).length).toBe(1);
    const optimistic = store.messagesOf(CONVERSATION_ID)[0];
    expect(optimistic.body).toBe("hello there");
    expect("pending" in optimistic && optimistic.pending).toBeTrue();

    await settle();
    const posted = http.expectOne(
      (request) =>
        request.method === "POST" &&
        request.url === `${base}/conversations/c1/messages`,
    );
    const clientMessageId = (
      posted.request.body as { client_message_id: string }
    ).client_message_id;
    posted.flush({
      data: message({
        id: "server-1",
        senderOwnerId: OWNER,
        body: "hello there",
        clientMessageId,
      }),
    });
    await sending;

    expect(store.messagesOf(CONVERSATION_ID).length).toBe(1);
    expect(store.messagesOf(CONVERSATION_ID)[0].id).toBe("server-1");
  });

  it("marks a failed send retryable without duplicating it", async () => {
    const opening = store.openConversation("c1");
    await flushMessages("c1", []);
    await opening;

    const sending = store.sendMessage("c1", "will fail");
    await flushPost("c1", () => "error");
    await sending;

    const rows = store.messagesOf(CONVERSATION_ID);
    expect(rows.length).toBe(1);
    expect("failed" in rows[0] && rows[0].failed).toBeTrue();

    // The retry reuses the original client id, which is what makes the server
    // dedupe it instead of posting twice.
    const clientMessageId = rows[0].clientMessageId;
    const retrying = store.retryMessage("c1", clientMessageId);
    const retriedWith = await flushPost("c1", (id) =>
      message({ id: "server-2", senderOwnerId: OWNER, clientMessageId: id }),
    );
    expect(retriedWith).toBe(clientMessageId);
    await retrying;

    expect(store.messagesOf(CONVERSATION_ID).length).toBe(1);
    expect(store.messagesOf(CONVERSATION_ID)[0].id).toBe("server-2");
  });

  it("appends an inbound message.new frame to the open thread", async () => {
    const opening = store.openConversation("c1");
    await flushMessages("c1", []);
    await opening;

    realtime.frames$.next({
      t: "message.new",
      d: { conversation_id: "c1", message: message({ id: "socket-1" }) },
    });

    expect(store.messagesOf(CONVERSATION_ID).map((m) => m.id)).toContain(
      "socket-1",
    );
  });

  it("does not duplicate the sender's own echo of a message", async () => {
    const opening = store.openConversation("c1");
    await flushMessages("c1", []);
    await opening;

    const sending = store.sendMessage("c1", "one copy only");
    await settle();
    const posted = http.expectOne(
      (request) =>
        request.method === "POST" &&
        request.url === `${base}/conversations/c1/messages`,
    );
    const clientMessageId = (
      posted.request.body as { client_message_id: string }
    ).client_message_id;
    const saved = message({
      id: "server-3",
      senderOwnerId: OWNER,
      body: "one copy only",
      clientMessageId,
    });
    posted.flush({ data: saved });
    await sending;

    // The sender's own socket echoes what it just posted.
    realtime.frames$.next({
      t: "message.new",
      d: { conversation_id: "c1", message: saved },
    });

    expect(store.messagesOf(CONVERSATION_ID).length).toBe(1);
  });

  it("ignores a frame for a thread that was never opened", () => {
    realtime.frames$.next({
      t: "message.new",
      d: { conversation_id: "never-opened", message: message() },
    });

    // Nothing to append to: the page loads from REST when it is opened.
    expect(store.messagesOf(CONVERSATION_ID).length).toBe(0);
  });

  it("applies a read receipt to the participant watermark", async () => {
    const loading = store.loadConversations();
    await flushConversations([conversation({ unread: false })]);
    await flushLookup();
    await loading;

    realtime.frames$.next({
      t: "receipt.read",
      d: {
        conversation_id: "c1",
        owner_id: OTHER,
        last_read_at: "2026-09-08T10:05:00.000Z",
      },
    });

    const participant = store
      .conversations()[0]
      .participants.find((p) => p.ownerId === OTHER);
    expect(participant?.lastReadAt).toBe("2026-09-08T10:05:00.000Z");
  });

  it("reports a message as read only once every other participant has read it", () => {
    const own = message({
      senderOwnerId: OWNER,
      createdAt: "2026-09-08T10:00:00.000Z",
    });

    const unread = conversation({
      participants: [
        { ownerId: OWNER, role: "admin", lastReadAt: null },
        {
          ownerId: OTHER,
          role: "member",
          lastReadAt: "2026-09-08T09:00:00.000Z",
        },
      ],
    });
    expect(store.readersOf(unread, own)).toEqual([]);

    const read = conversation({
      participants: [
        { ownerId: OWNER, role: "admin", lastReadAt: null },
        {
          ownerId: OTHER,
          role: "member",
          lastReadAt: "2026-09-08T10:00:00.000Z",
        },
      ],
    });
    expect(store.readersOf(read, own)).toEqual([OTHER]);
  });

  it("creates a direct conversation and opens it", async () => {
    const starting = store.startDirectConversation(OTHER);
    await settle();
    await settle();
    http
      .expectOne(
        (request) =>
          request.method === "POST" && request.url === `${base}/conversations`,
      )
      .flush({ data: conversation({ id: "c-new" }) });
    await flushLookup();
    await flushMessages("c-new", []);
    const id = await starting;

    expect(id).toBe("c-new");
    expect(store.activeConversationId()).toBe("c-new");
  });

  it("closes the previous thread's socket subscription when switching", async () => {
    const first = store.openConversation("c1");
    await flushMessages("c1", []);
    await first;

    const second = store.openConversation("c2");
    await flushMessages("c2", []);
    await second;

    // Leaving a subscription open would keep delivering typing frames for a
    // thread nobody is looking at.
    expect(realtime.closed).toContain("c1");
  });

  describe("attachments", () => {
    const file = new File(["hello"], "spec.pdf", { type: "application/pdf" });

    it("shows the row immediately, then sends the file id", async () => {
      const opening = store.openConversation("c1");
      await flushMessages("c1", []);
      await opening;

      const sending = store.sendAttachment("c1", file);

      // The row is on screen before Azure has been touched.
      const optimistic = store.messagesOf(CONVERSATION_ID)[0];
      expect(optimistic.kind).toBe("attachment");
      // The body carries the filename: a recipient renders the card from it,
      // because file-service would refuse them the file's metadata.
      expect(optimistic.body).toBe("spec.pdf");
      expect("pending" in optimistic && optimistic.pending).toBeTrue();

      const clientMessageId = await flushPost("c1", (id) =>
        message({
          id: "server-att",
          senderOwnerId: OWNER,
          kind: "attachment",
          body: "spec.pdf",
          attachmentFileId: "file-1",
          clientMessageId: id,
        }),
      );
      await sending;

      expect(clientMessageId).toBe(optimistic.clientMessageId);
      expect(store.messagesOf(CONVERSATION_ID).length).toBe(1);
      expect(store.messagesOf(CONVERSATION_ID)[0].attachmentFileId).toBe(
        "file-1",
      );
    });

    it("never posts a message when the upload fails", async () => {
      uploads.failTimes = 1;
      const opening = store.openConversation("c1");
      await flushMessages("c1", []);
      await opening;

      await store.sendAttachment("c1", file);

      const row = store.messagesOf(CONVERSATION_ID)[0];
      expect("failed" in row && row.failed).toBeTrue();
      // A message pointing at a blob that never landed would be worse than none.
      http.expectNone(
        (request) =>
          request.method === "POST" &&
          request.url === `${base}/conversations/c1/messages`,
      );
    });

    it("re-uploads on retry, keeping the original client id", async () => {
      uploads.failTimes = 1;
      const opening = store.openConversation("c1");
      await flushMessages("c1", []);
      await opening;

      await store.sendAttachment("c1", file);
      const clientMessageId =
        store.messagesOf(CONVERSATION_ID)[0].clientMessageId;
      expect(uploads.attempts).toBe(1);

      const retrying = store.retryMessage("c1", clientMessageId);
      const retriedWith = await flushPost("c1", (id) =>
        message({
          id: "server-att-2",
          senderOwnerId: OWNER,
          kind: "attachment",
          body: "spec.pdf",
          attachmentFileId: "file-2",
          clientMessageId: id,
        }),
      );
      await retrying;

      expect(uploads.attempts).toBe(2);
      // Same idempotency key, so the server cannot end up with two messages.
      expect(retriedWith).toBe(clientMessageId);
      expect(store.messagesOf(CONVERSATION_ID).length).toBe(1);
    });

    it("fetches a download grant on demand", async () => {
      const asking = store.attachmentGrant("c1", "m-att");
      await settle();
      http
        .expectOne(`${base}/conversations/c1/messages/m-att/attachment`)
        .flush({
          data: {
            name: "spec.pdf",
            download_url: "https://blob.example.com/spec.pdf?sig=abc",
            expires_at: "2026-09-08T10:05:00.000Z",
          },
        });

      await expectAsync(asking).toBeResolvedTo({
        name: "spec.pdf",
        downloadUrl: "https://blob.example.com/spec.pdf?sig=abc",
        expiresAt: "2026-09-08T10:05:00.000Z",
        // A document has no derivative; the fields exist and are null.
        thumbnailUrl: null,
        width: null,
        height: null,
      });
    });

    it("paints the sender's thumbnail, not the original", async () => {
      // Painting a 288px box from a 12 MB original is what this replaced.
      void store.ensureAttachmentPreview("c1", "m-img", "holiday.png");
      await settle();
      http
        .expectOne(`${base}/conversations/c1/messages/m-img/attachment`)
        .flush({
          data: {
            name: "holiday.png",
            download_url: "https://blob.example.com/full.png?sig=abc",
            expires_at: "2026-09-08T10:05:00.000Z",
            thumbnail_url: "https://blob.example.com/thumb.webp?sig=abc",
            width: 4032,
            height: 3024,
          },
        });
      await settle();

      expect(store.attachmentPreviews().get("m-img")).toBe(
        "https://blob.example.com/thumb.webp?sig=abc",
      );
      // And the shape, so the bubble reserves it before the bytes land.
      expect(store.attachmentAspects().get("m-img")).toBeCloseTo(
        4032 / 3024,
        3,
      );
    });

    it("falls back to the original when there is no thumbnail", async () => {
      void store.ensureAttachmentPreview("c1", "m-old", "old.png");
      await settle();
      http
        .expectOne(`${base}/conversations/c1/messages/m-old/attachment`)
        .flush({
          data: {
            name: "old.png",
            download_url: "https://blob.example.com/old.png?sig=abc",
            expires_at: "2026-09-08T10:05:00.000Z",
            thumbnail_url: null,
            width: null,
            height: null,
          },
        });
      await settle();

      expect(store.attachmentPreviews().get("m-old")).toBe(
        "https://blob.example.com/old.png?sig=abc",
      );
      expect(store.attachmentAspects().has("m-old")).toBeFalse();
    });
  });

  describe("call history", () => {
    /**
     * The row is written by messenger-service's JetStream consumer, well after
     * the socket frame that ends the call — so nothing refetched it and the
     * thread showed no call until a manual reload (reported 2026-09-11).
     */
    it("refetches the thread's calls when a live call ends", async () => {
      const opening = store.openConversation(CONVERSATION_ID);
      await flushCalls(CONVERSATION_ID, []);
      await flushMessages(CONVERSATION_ID, [message()]);
      await flushRead(CONVERSATION_ID, "2026-09-08T10:00:00.000Z");
      await opening;
      expect(store.callsOf(CONVERSATION_ID)).toEqual([]);

      calls.start(CONVERSATION_ID, "call-1");
      TestBed.tick();
      calls.end();
      TestBed.tick();

      await flushCalls(CONVERSATION_ID, [callRecord()]);
      expect(store.callsOf(CONVERSATION_ID).map((call) => call.id)).toEqual([
        "call-1",
      ]);
    });

    /*
     * The whole of click-to-join: a call becomes a history row the moment
     * somebody joins it, so a row with no `endedAt` is a call still going on
     * and the thread can offer a way in. This is what let the auto-rejoin be
     * deleted rather than debugged a fourth time — and it needed no change in
     * messenger-service at all (2026-09-15).
     */
    it("reports a call with no end as the thread's ongoing call", async () => {
      const opening = store.openConversation(CONVERSATION_ID);
      await flushCalls(CONVERSATION_ID, [
        callRecord(),
        callRecord({
          id: "call-live",
          status: "active",
          endedAt: null,
          endReason: null,
          durationSeconds: 0,
        }),
      ]);
      await flushMessages(CONVERSATION_ID, [message()]);
      await flushRead(CONVERSATION_ID, "2026-09-08T10:00:00.000Z");
      await opening;

      expect(store.ongoingCallOf(CONVERSATION_ID)?.id).toBe("call-live");
    });

    it("offers no way into a call it is already in", async () => {
      // The dock is on screen for a call we hold, and a Join button beside it
      // would be offering to join twice.
      const opening = store.openConversation(CONVERSATION_ID);
      await flushCalls(CONVERSATION_ID, [
        callRecord({ id: "call-live", status: "active", endedAt: null }),
      ]);
      await flushMessages(CONVERSATION_ID, [message()]);
      await flushRead(CONVERSATION_ID, "2026-09-08T10:00:00.000Z");
      await opening;
      expect(store.ongoingCallOf(CONVERSATION_ID)?.id).toBe("call-live");

      calls.start(CONVERSATION_ID, "call-live");
      TestBed.tick();

      expect(store.ongoingCallOf(CONVERSATION_ID)).toBeNull();
    });

    it("keeps the ongoing call's headcount honest from the fanout", async () => {
      // `call.participant` carries the whole joined set rather than a delta,
      // so the row is replaced rather than incremented — a client that missed
      // a frame re-syncs from the next one instead of drifting.
      const opening = store.openConversation(CONVERSATION_ID);
      await flushCalls(CONVERSATION_ID, [
        callRecord({
          id: "call-live",
          status: "active",
          endedAt: null,
          joinedOwnerIds: [OWNER],
        }),
      ]);
      await flushMessages(CONVERSATION_ID, [message()]);
      await flushRead(CONVERSATION_ID, "2026-09-08T10:00:00.000Z");
      await opening;

      realtime.frames$.next({
        t: "call.participant",
        d: {
          call_id: "call-live",
          owner_id: OTHER,
          state: "joined",
          participants: [OWNER, OTHER],
        },
      });
      await settle();

      expect(store.ongoingCallOf(CONVERSATION_ID)?.joinedOwnerIds).toEqual([
        OWNER,
        OTHER,
      ]);
    });

    it("finds the thread for a call it was only rung by", async () => {
      /*
       * The common way into the banner: someone lets the ring run out rather
       * than declining it, so no history row was ever fetched for the call.
       * `call.participant` is what says somebody has joined and the row now
       * exists — and it names only the call, so the conversation has to come
       * from the `call.incoming` that rang. Without that mapping the banner
       * never appears for anyone who did not pick up.
       */
      const opening = store.openConversation(CONVERSATION_ID);
      await flushCalls(CONVERSATION_ID, []);
      await flushMessages(CONVERSATION_ID, [message()]);
      await flushRead(CONVERSATION_ID, "2026-09-08T10:00:00.000Z");
      await opening;

      realtime.frames$.next({
        t: "call.incoming",
        d: {
          call_id: "call-live",
          conversation_id: CONVERSATION_ID,
          from: OTHER,
          media: "audio",
          participants: [OWNER, OTHER],
        },
      });
      realtime.frames$.next({
        t: "call.participant",
        d: {
          call_id: "call-live",
          owner_id: OTHER,
          state: "joined",
          participants: [OTHER],
        },
      });

      await flushCalls(CONVERSATION_ID, [
        callRecord({ id: "call-live", status: "active", endedAt: null }),
      ]);
      await settle();

      expect(store.ongoingCallOf(CONVERSATION_ID)?.id).toBe("call-live");
    });

    it("takes the banner away the moment the call ends", async () => {
      /*
       * dathq's bug (2026-09-15): three people in a call, one leaves, the call
       * ends — and the last person was still offered Join for it, which then
       * hit a call that no longer existed. Two causes, both here. The row is
       * projected asynchronously, so for a second after `call.ended` the read
       * model still says `ended_at: null`; and the refetch was waiting for the
       * row to be *present*, which it had been since the call started, so it
       * stopped on the first fetch and kept the open row.
       *
       * The frame is authoritative and instant. Nothing waits for postgres to
       * agree before withdrawing a way into a dead call.
       */
      const opening = store.openConversation(CONVERSATION_ID);
      await flushCalls(CONVERSATION_ID, [
        callRecord({ id: "call-live", status: "active", endedAt: null }),
      ]);
      await flushMessages(CONVERSATION_ID, [message()]);
      await flushRead(CONVERSATION_ID, "2026-09-08T10:00:00.000Z");
      await opening;
      expect(store.ongoingCallOf(CONVERSATION_ID)?.id).toBe("call-live");

      realtime.frames$.next({
        t: "call.ended",
        d: { call_id: "call-live", reason: "empty" },
      });

      expect(store.ongoingCallOf(CONVERSATION_ID))
        .withContext("gone on the frame, not on the projection")
        .toBeNull();

      // And it stays gone even though the projection has not caught up yet.
      await flushCalls(CONVERSATION_ID, [
        callRecord({ id: "call-live", status: "active", endedAt: null }),
      ]);
      expect(store.ongoingCallOf(CONVERSATION_ID))
        .withContext("a lagging read model cannot bring it back")
        .toBeNull();
    });

    it("keeps refetching until the ended call actually reads as ended", async () => {
      // The retry existed and did nothing: a call gets its row when somebody
      // joins, so "is it present" was already true and the loop stopped on the
      // first fetch, leaving the open row in the timeline.
      const opening = store.openConversation(CONVERSATION_ID);
      await flushCalls(CONVERSATION_ID, [
        callRecord({ id: "call-live", status: "active", endedAt: null }),
      ]);
      await flushMessages(CONVERSATION_ID, [message()]);
      await flushRead(CONVERSATION_ID, "2026-09-08T10:00:00.000Z");
      await opening;

      const refreshing = store.refreshCalls(
        CONVERSATION_ID,
        "call-live",
        "ended",
      );

      // First fetch: still open, so the loop must go round again.
      await flushCalls(CONVERSATION_ID, [
        callRecord({ id: "call-live", status: "active", endedAt: null }),
      ]);
      // The retry waits 600 ms before asking again, and draining microtasks
      // does not move a timer — without this the second request has not been
      // issued yet and the flush below finds nothing.
      await new Promise((resolve) => setTimeout(resolve, 700));
      await flushCalls(CONVERSATION_ID, [
        callRecord({ id: "call-live", status: "completed" }),
      ]);
      await refreshing;

      expect(
        store.callsOf(CONVERSATION_ID).find((call) => call.id === "call-live")
          ?.endedAt,
      ).not.toBeNull();
    });
  });
  describe("unread reconciliation", () => {
    /*
     * dathq, 2026-09-16, with a screenshot: "I've read this chat. The icon on
     * the header is gucci, but in the chat you can see there's still a pink
     * dot". The header count is computed server-side on every poll; the dot is
     * a flag on a cached row, and two mechanisms restored it between them —
     * a list refetch replacing settled local state, and a write-dedupe that
     * also skipped the local clear, which made the restored dot permanent.
     */
    it("keeps the open thread read when a refetch says otherwise", async () => {
      const loading = store.loadConversations();
      await flushConversations([conversation({ unread: false })]);
      await flushLookup();
      await loading;

      const opening = store.openConversation(CONVERSATION_ID);
      await flushCalls(CONVERSATION_ID, []);
      await flushMessages(CONVERSATION_ID, [message()]);
      await flushRead(CONVERSATION_ID, "2026-09-08T10:00:00.000Z");
      await opening;
      expect(store.conversationById(CONVERSATION_ID)?.unread).toBe(false);

      // The refetch both surfaces mount with, answered from a watermark write
      // that had not landed when the query ran.
      const refetch = store.loadConversations();
      await flushConversations([conversation({ unread: true })]);
      await flushLookup();
      await refetch;

      expect(store.conversationById(CONVERSATION_ID)?.unread).toBe(false);
    });

    it("clears a restored dot even when the watermark write is a duplicate", async () => {
      // The dedupe is what made this permanent: the newest message was already
      // marked, so every later attempt returned before touching the flag.
      const loading = store.loadConversations();
      await flushConversations([conversation({ unread: false })]);
      await flushLookup();
      await loading;

      const opening = store.openConversation(CONVERSATION_ID);
      await flushCalls(CONVERSATION_ID, []);
      await flushMessages(CONVERSATION_ID, [message()]);
      await flushRead(CONVERSATION_ID, "2026-09-08T10:00:00.000Z");
      await opening;

      // Something puts the dot back while the same message is still newest.
      store["conversationList"].update((list: readonly Conversation[]) =>
        list.map((c) => ({ ...c, unread: true })),
      );
      expect(store.conversationById(CONVERSATION_ID)?.unread).toBe(true);

      // Reading it again marks nothing new, and must still clear the flag.
      store.markActiveRead();
      await settle();

      expect(store.conversationById(CONVERSATION_ID)?.unread).toBe(false);
    });
  });

  describe("call activity and list order", () => {
    /*
     * dathq, 2026-09-16: "the call in the chat doesn't affect the ordering in
     * the chat list?". It did not. `last_message_at` was the sort key and only
     * the message path wrote it, so an hour-long call moved a conversation
     * nowhere. The sort key is now `lastActivityAt`, which the call projection
     * advances too.
     */
    const OTHER_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

    it("moves a conversation up the list when a call lands in it", async () => {
      const loading = store.loadConversations();
      await flushConversations([
        // The quiet one, whose last message is older...
        conversation({
          id: CONVERSATION_ID,
          lastMessageAt: "2026-09-08T10:00:00.000Z",
          lastActivityAt: "2026-09-08T10:00:00.000Z",
        }),
        // ...than the other conversation's, so it starts second.
        conversation({
          id: OTHER_ID,
          lastMessageAt: "2026-09-08T11:00:00.000Z",
          lastActivityAt: "2026-09-08T11:00:00.000Z",
          lastMessage: message({ id: "m2", conversationId: OTHER_ID }),
        }),
      ]);
      await flushLookup();
      await loading;
      expect(store.conversations().map((c) => c.id)).toEqual([
        OTHER_ID,
        CONVERSATION_ID,
      ]);

      // A call in the older conversation, ending after the other's last message.
      const opening = store.openConversation(CONVERSATION_ID);
      await flushCalls(CONVERSATION_ID, [
        callRecord({
          startedAt: "2026-09-08T12:00:00.000Z",
          endedAt: "2026-09-08T12:04:12.000Z",
        }),
      ]);
      await flushMessages(CONVERSATION_ID, [message()]);
      await flushRead(CONVERSATION_ID, "2026-09-08T10:00:00.000Z");
      await opening;

      expect(store.conversations().map((c) => c.id)).toEqual([
        CONVERSATION_ID,
        OTHER_ID,
      ]);
      expect(store.conversationById(CONVERSATION_ID)?.lastActivityAt).toBe(
        "2026-09-08T12:04:12.000Z",
      );
    });

    it("carries the call itself, so the row can say what the activity was", async () => {
      const loading = store.loadConversations();
      await flushConversations([conversation()]);
      await flushLookup();
      await loading;
      expect(store.conversationById(CONVERSATION_ID)?.lastCall).toBeNull();

      const opening = store.openConversation(CONVERSATION_ID);
      await flushCalls(CONVERSATION_ID, [
        callRecord({ id: "call-9", endedAt: "2026-09-08T12:04:12.000Z" }),
      ]);
      await flushMessages(CONVERSATION_ID, [message()]);
      await flushRead(CONVERSATION_ID, "2026-09-08T10:00:00.000Z");
      await opening;

      expect(store.conversationById(CONVERSATION_ID)?.lastCall?.id).toBe(
        "call-9",
      );
    });

    it("never pulls a conversation back down for an older call", async () => {
      // A late fetch of call history must not rewind the list, the same way
      // GREATEST stops a redelivered projection rewinding the column.
      const loading = store.loadConversations();
      await flushConversations([
        conversation({
          lastMessageAt: "2026-09-08T18:00:00.000Z",
          lastActivityAt: "2026-09-08T18:00:00.000Z",
        }),
      ]);
      await flushLookup();
      await loading;

      const opening = store.openConversation(CONVERSATION_ID);
      await flushCalls(CONVERSATION_ID, [callRecord()]);
      await flushMessages(CONVERSATION_ID, [message()]);
      await flushRead(CONVERSATION_ID, "2026-09-08T10:00:00.000Z");
      await opening;

      expect(store.conversationById(CONVERSATION_ID)?.lastActivityAt).toBe(
        "2026-09-08T18:00:00.000Z",
      );
    });
  });

  describe("groups", () => {
    const groupConversation = () =>
      conversation({
        id: "g1",
        type: "group",
        title: "Ops",
        participants: [
          { ownerId: OWNER, role: "admin", lastReadAt: null },
          { ownerId: OTHER, role: "member", lastReadAt: null },
          { ownerId: "google_third", role: "member", lastReadAt: null },
        ],
      });

    /**
     * The title is omitted rather than sent empty: messenger-service stores
     * what it is given, and a stored "" is not the same as null — the list
     * derives a name from the members only when the column is null, so a blank
     * string would render a group with no name at all.
     */
    it("omits a blank title instead of sending an empty string", async () => {
      const creating = store.startGroupConversation(
        [OTHER, "google_third"],
        "  ",
      );
      await settle();

      const request = http.expectOne(
        (r) => r.method === "POST" && r.url === `${base}/conversations`,
      );
      expect(request.request.body).toEqual({
        type: "group",
        participant_owner_ids: [OTHER, "google_third"],
      });

      request.flush({ data: groupConversation() });
      await settle();
      for (const pending of http.match((r) =>
        r.url.includes("/users/lookup"),
      )) {
        pending.flush({ data: [] });
      }
      await settle();
      for (const pending of http.match(() => true)) pending.flush({ data: [] });
      await creating;
    });

    it("sends a trimmed title when one is typed", async () => {
      void store.startGroupConversation([OTHER, "google_third"], "  Ops  ");
      await settle();

      const request = http.expectOne(
        (r) => r.method === "POST" && r.url === `${base}/conversations`,
      );
      expect(request.request.body).toEqual({
        type: "group",
        participant_owner_ids: [OTHER, "google_third"],
        title: "Ops",
      });
    });

    /**
     * The dialog no longer lets a name be cleared — a group always has one —
     * but the API is nullable and this mapping is the contract with it: an
     * empty string would pass the server's schema and store a title that
     * renders blank, which is a different thing from having no title.
     */
    it("maps an empty title to null rather than an empty string", async () => {
      void store.renameConversation("g1", "   ");
      await settle();

      const request = http.expectOne(
        (r) => r.method === "PATCH" && r.url === `${base}/conversations/g1`,
      );
      expect(request.request.body).toEqual({ title: null });
    });

    it("applies an added member to the loaded conversation", async () => {
      const loading = store.loadConversations();
      await flushConversations([groupConversation()]);
      await flushLookup();
      await loading;

      const adding = store.addParticipants("g1", ["google_fourth"]);
      await settle();
      http
        .expectOne(
          (r) =>
            r.method === "POST" &&
            r.url === `${base}/conversations/g1/participants`,
        )
        .flush({
          data: [
            { ownerId: OWNER, role: "admin", lastReadAt: null },
            { ownerId: OTHER, role: "member", lastReadAt: null },
            { ownerId: "google_third", role: "member", lastReadAt: null },
            { ownerId: "google_fourth", role: "member", lastReadAt: null },
          ],
        });
      await settle();
      for (const pending of http.match((r) =>
        r.url.includes("/users/lookup"),
      )) {
        pending.flush({ data: [] });
      }
      expect(await adding).toBeTrue();

      const group = store.conversations().find((c) => c.id === "g1");
      expect(group?.participants.map((p) => p.ownerId)).toEqual([
        OWNER,
        OTHER,
        "google_third",
        "google_fourth",
      ]);
    });

    it("drops the conversation from the list after leaving", async () => {
      const loading = store.loadConversations();
      await flushConversations([groupConversation()]);
      await flushLookup();
      await loading;
      expect(store.conversations().length).toBe(1);

      const leaving = store.leaveConversation("g1");
      await settle();
      http
        .expectOne(
          (r) =>
            r.method === "DELETE" &&
            r.url === `${base}/conversations/g1/participants/me`,
        )
        .flush(null, { status: 204, statusText: "No Content" });
      expect(await leaving).toBeTrue();
      expect(store.conversations()).toEqual([]);
    });

    it("resolves this user's own name, which a member list has to show", async () => {
      const loading = store.loadConversations();
      await flushConversations([groupConversation()]);
      await settle();
      const lookups = http.match((r) => r.url.includes("/users/lookup"));
      const asked = lookups
        .flatMap((r) => (r.request.params.get("owner_ids") ?? "").split(","))
        .filter(Boolean);
      expect(asked).toContain(OWNER);
      for (const request of lookups) {
        request.flush({
          data: [
            {
              ownerId: OWNER,
              email: "me@example.com",
              displayName: "Me Myself",
              pictureUrl: "",
            },
          ],
        });
      }
      await loading;

      expect(store.displayName(OWNER)).toBe("Me Myself");
    });

    it("reads this user's own role, not the first participant's", () => {
      const asMember = conversation({
        id: "g2",
        type: "group",
        participants: [
          { ownerId: OTHER, role: "admin", lastReadAt: null },
          { ownerId: OWNER, role: "member", lastReadAt: null },
        ],
      });
      expect(store.isAdminOf(groupConversation())).toBeTrue();
      expect(store.isAdminOf(asMember)).toBeFalse();
    });
  });
  /**
   * Phase 3 slice 4 puts more than one thread on screen at once: the chats
   * page shows one and a docked mini window shows another — or the same one.
   * Until then the store could only represent "the open thread", and opening
   * anything closed the last.
   */
  describe("more than one surface on one thread", () => {
    const DOCK = "dock:c1";
    const OTHER_ID = "c2";
    const READ_AT = "2026-09-08T10:00:00.000Z";

    /** Answers everything a cold open asks for. */
    const settleOpen = async (
      opening: Promise<void>,
      conversationId: string,
    ) => {
      await flushMessages(conversationId, [
        message({ id: `m-${conversationId}`, conversationId }),
      ]);
      await flushRead(conversationId, READ_AT);
      await opening;
    };

    it("subscribes once while two surfaces show the same thread", async () => {
      await settleOpen(
        store.openConversation(CONVERSATION_ID),
        CONVERSATION_ID,
      );
      // Loaded and in the list by now, so the dock's open fetches nothing but
      // the call history — it only has to join the subscription.
      await store.openThread(CONVERSATION_ID, DOCK);

      expect(
        realtime.opened.filter((id) => id === CONVERSATION_ID).length,
      ).toBe(1);
    });

    it("keeps the subscription while any surface still shows the thread", async () => {
      await settleOpen(
        store.openConversation(CONVERSATION_ID),
        CONVERSATION_ID,
      );
      await store.openThread(CONVERSATION_ID, DOCK);

      // The page moves on. The dock is still showing the thread it left, so
      // unsubscribing here takes that window's typing indicators and live
      // messages away with no sign that anything happened.
      await settleOpen(store.openConversation(OTHER_ID), OTHER_ID);
      expect(realtime.closed).not.toContain(CONVERSATION_ID);

      // Last holder lets go, and only now does the subscription end.
      store.closeThread(CONVERSATION_ID, DOCK);
      expect(realtime.closed).toContain(CONVERSATION_ID);
    });

    it("does not make a docked thread the page's active one", async () => {
      await settleOpen(
        store.openConversation(CONVERSATION_ID),
        CONVERSATION_ID,
      );
      await settleOpen(store.openThread(OTHER_ID, DOCK), OTHER_ID);

      expect(store.activeConversationId()).toBe(CONVERSATION_ID);
      expect(store.messagesOf(OTHER_ID).length).toBe(1);
    });

    it("flags loading for the thread being fetched, not for every thread", async () => {
      await settleOpen(
        store.openConversation(CONVERSATION_ID),
        CONVERSATION_ID,
      );

      const docking = store.openThread(OTHER_ID, DOCK);
      await settle();
      expect(store.loadingOf(OTHER_ID)).toBeTrue();
      // The page's thread is loaded and must not put its skeleton back up
      // because some other window is fetching.
      expect(store.loadingOf(CONVERSATION_ID)).toBeFalse();

      await settleOpen(docking, OTHER_ID);
      expect(store.loadingOf(OTHER_ID)).toBeFalse();
    });
  });
});
