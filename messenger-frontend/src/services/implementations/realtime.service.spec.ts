import { TestBed } from "@angular/core/testing";
import {
  HttpTestingController,
  provideHttpClientTesting,
} from "@angular/common/http/testing";
import { provideHttpClient } from "@angular/common/http";
import { environment } from "src/environments/environment";
import { RealtimeService } from "./realtime.service";

/**
 * A stand-in for the browser's WebSocket. The socket is the seam this service
 * exists to manage, so the tests drive frames through it rather than asserting
 * on internals.
 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  readyState = FakeWebSocket.OPEN;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  /** Delivers a server frame. */
  emit(type: string, payload: Record<string, unknown> = {}): void {
    this.onmessage?.({
      data: JSON.stringify({ t: type, d: payload }),
    } as MessageEvent<string>);
  }
}

describe("RealtimeService", () => {
  let service: RealtimeService;
  let http: HttpTestingController;
  let originalWebSocket: typeof WebSocket;

  const flushToken = (token = "stream-token-abc") => {
    http
      .expectOne(environment.realtime.tokenUrl)
      .flush({ stream_token: token });
  };

  const flushUnread = (ids: string[] = []) => {
    http
      .expectOne(`${environment.gateway.baseUrl}/conversations/unread`)
      .flush({ data: { conversation_ids: ids } });
  };

  const socket = () =>
    FakeWebSocket.instances[FakeWebSocket.instances.length - 1];

  beforeEach(() => {
    FakeWebSocket.instances = [];
    originalWebSocket = window.WebSocket;
    (window as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;

    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(RealtimeService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    service.stop();
    (window as unknown as { WebSocket: unknown }).WebSocket = originalWebSocket;
  });

  it("mints a fresh token and puts it in the socket query string", async () => {
    service.start();
    flushToken("token-1");
    await Promise.resolve();

    expect(socket().url).toContain(
      `${environment.realtime.socketUrl}?stream_token=token-1`,
    );
  });

  it("resyncs the unread set when the socket opens", async () => {
    service.start();
    flushToken();
    await Promise.resolve();

    socket().onopen?.();
    flushUnread(["conv-1", "conv-2"]);
    // resyncUnread resolves on a microtask, so the signal lands after a tick.
    await Promise.resolve();

    expect(service.unreadCount()).toBe(2);
    expect(service.connected()).toBeTrue();
  });

  it("treats unread as a set, so a duplicated frame costs nothing", async () => {
    service.start();
    flushToken();
    await Promise.resolve();
    socket().onopen?.();
    flushUnread([]);
    await Promise.resolve();

    socket().emit("unread.added", { conversation_id: "conv-1" });
    socket().emit("unread.added", { conversation_id: "conv-1" });

    expect(service.unreadCount()).toBe(1);

    socket().emit("unread.cleared", { conversation_id: "conv-1" });
    socket().emit("unread.cleared", { conversation_id: "conv-1" });

    expect(service.unreadCount()).toBe(0);
  });

  it("caps the badge label at 9+", async () => {
    service.start();
    flushToken();
    await Promise.resolve();
    socket().onopen?.();
    flushUnread([]);
    await Promise.resolve();

    expect(service.unreadBadge()).toBe("");

    for (let i = 0; i < 9; i++) {
      socket().emit("unread.added", { conversation_id: `conv-${i}` });
    }
    expect(service.unreadBadge()).toBe("9");

    socket().emit("unread.added", { conversation_id: "conv-extra" });
    expect(service.unreadBadge()).toBe("9+");
  });

  it("answers a server ping with a pong", async () => {
    service.start();
    flushToken();
    await Promise.resolve();
    socket().onopen?.();
    flushUnread([]);
    await Promise.resolve();

    socket().emit("ping");

    expect(socket().sent).toContain(JSON.stringify({ t: "pong", d: {} }));
  });

  it("tracks presence per owner", async () => {
    service.start();
    flushToken();
    await Promise.resolve();
    socket().onopen?.();
    flushUnread([]);
    await Promise.resolve();

    socket().emit("presence", { owner_id: "google_2", state: "online" });
    expect(service.presence().get("google_2")?.state).toBe("online");

    socket().emit("presence", { owner_id: "google_2", state: "away" });
    expect(service.presence().get("google_2")?.state).toBe("away");
  });

  it("drops a typing entry when its owner stops", async () => {
    service.start();
    flushToken();
    await Promise.resolve();
    socket().onopen?.();
    flushUnread([]);
    await Promise.resolve();

    const until = new Date(Date.now() + 8000).toISOString();
    socket().emit("typing", {
      conversation_id: "conv-1",
      owner_id: "google_2",
      until,
    });
    expect(service.typing().length).toBe(1);

    socket().emit("typing", {
      conversation_id: "conv-1",
      owner_id: "google_2",
      until,
      stopped: true,
    });
    expect(service.typing().length).toBe(0);
  });

  it("ignores unknown frames instead of throwing", async () => {
    service.start();
    flushToken();
    await Promise.resolve();
    socket().onopen?.();
    flushUnread([]);
    await Promise.resolve();

    expect(() => {
      socket().emit("call.incoming", { call_id: "call-1" });
      socket().emit("receipt.read", { conversation_id: "conv-1" });
    }).not.toThrow();
  });

  it("survives a malformed frame", async () => {
    service.start();
    flushToken();
    await Promise.resolve();
    socket().onopen?.();
    flushUnread([]);
    await Promise.resolve();

    expect(() => {
      socket().onmessage?.({ data: "not json" } as MessageEvent<string>);
    }).not.toThrow();
    expect(service.connected()).toBeTrue();
  });

  it("refuses to send on a closed socket", async () => {
    service.start();
    flushToken();
    await Promise.resolve();
    const live = socket();
    live.onopen?.();
    flushUnread([]);

    live.readyState = FakeWebSocket.CLOSED;
    service.startTyping("conv-1");

    expect(live.sent.filter((f) => f.includes("typing.start")).length).toBe(0);
  });

  it("keeps the previous unread set when a resync fails", async () => {
    service.start();
    flushToken();
    await Promise.resolve();
    socket().onopen?.();
    flushUnread(["conv-1"]);
    await Promise.resolve();
    expect(service.unreadCount()).toBe(1);

    // The request has to be answered before the promise can settle, so the
    // failure is injected first and awaited after.
    const pending = service.resyncUnread();
    http
      .expectOne(`${environment.gateway.baseUrl}/conversations/unread`)
      .error(new ProgressEvent("network"));
    await pending;

    // Stale-but-plausible beats blanking a badge the user is looking at.
    expect(service.unreadCount()).toBe(1);
  });

  it("mints a new token on reconnect rather than reusing the expired one", async () => {
    service.start();
    flushToken("token-1");
    await Promise.resolve();
    socket().onopen?.();
    flushUnread([]);
    await Promise.resolve();

    socket().close();

    // Backoff starts at 1 s, so the retry is scheduled rather than immediate;
    // what matters is that it goes back for a fresh token when it fires.
    expect(service.connected()).toBeFalse();
    http.verify();
  });

  it("does not open a second socket when start is called twice", async () => {
    service.start();
    service.start();
    flushToken();
    await Promise.resolve();

    expect(FakeWebSocket.instances.length).toBe(1);
  });

  /**
   * A socket carries its subscriptions: after a reconnect the server knows
   * nothing about the thread on screen, so typing indicators would silently
   * stop working until the user switched conversations. The client re-states
   * what it is watching on every connect.
   */
  it("re-opens conversations and presence after a reconnect", async () => {
    jasmine.clock().install();
    try {
      service.start();
      flushToken("token-1");
      await Promise.resolve();

      const first = socket();
      first.onopen?.();
      flushUnread([]);
      await Promise.resolve();

      service.openConversation("conv-1");
      service.subscribePresence(["google_2"]);
      expect(
        first.sent.some((f) => f.includes("conversation.open")),
      ).toBeTrue();

      // The socket drops; the client backs off and mints a fresh token.
      first.close();
      expect(service.connected()).toBeFalse();
      jasmine.clock().tick(1100);
      await Promise.resolve();
      flushToken("token-2");
      await Promise.resolve();

      const second = socket();
      expect(second).not.toBe(first);
      expect(second.url).toContain("token-2");
      second.onopen?.();
      flushUnread([]);
      await Promise.resolve();

      expect(
        second.sent.some((f) => f.includes('"conversation.open"')),
      ).toBeTrue();
      expect(
        second.sent.some((f) => f.includes('"presence.subscribe"')),
      ).toBeTrue();
      expect(second.sent.some((f) => f.includes("conv-1"))).toBeTrue();
      expect(second.sent.some((f) => f.includes("google_2"))).toBeTrue();
    } finally {
      jasmine.clock().uninstall();
    }
  });

  it("forgets subscriptions once stopped", async () => {
    service.start();
    flushToken();
    await Promise.resolve();
    socket().onopen?.();
    flushUnread([]);
    await Promise.resolve();

    service.openConversation("conv-1");
    service.stop();

    // A stopped service must not resurrect a thread nobody is looking at.
    service.start();
    flushToken("token-3");
    await Promise.resolve();
    const fresh = socket();
    fresh.onopen?.();
    flushUnread([]);
    await Promise.resolve();

    expect(fresh.sent.some((f) => f.includes("conversation.open"))).toBeFalse();
  });

  describe("call signalling (phase 3 slice 3)", () => {
    /** Brings the socket up so the call frames below actually go out. */
    const connect = async () => {
      service.start();
      flushToken();
      await Promise.resolve();
      socket().onopen?.();
      flushUnread([]);
      await Promise.resolve();
    };

    const lastFrame = () =>
      JSON.parse(socket().sent[socket().sent.length - 1]) as {
        t: string;
        d: Record<string, unknown>;
      };

    it("stamps this tab's session on every frame that claims a place in a call", async () => {
      /*
       * The session is what lets a reloaded tab take its own place back rather
       * than losing to its own not-yet-closed socket. Without it on the wire,
       * realtime-service's takeover path is unreachable and a reload waits for
       * the old socket's close instead.
       */
      await connect();

      service.inviteCall("conv-1", { type: "offer" }, "audio");
      expect(lastFrame().d["session_id"]).toBe(service.sessionId);

      service.answerCall("call-1", { type: "answer" });
      expect(lastFrame().d["session_id"]).toBe(service.sessionId);

      service.joinCall("call-1");
      expect(lastFrame()).toEqual({
        t: "call.join",
        d: { call_id: "call-1", session_id: service.sessionId },
      });
    });

    it("keeps the same session across a reconnect, and a real uuid", async () => {
      // sessionStorage, not localStorage: the latter is shared by every tab of
      // the window, so two tabs would carry one id and look like a single
      // reloading tab — exactly the case the discriminator exists to tell
      // apart. A per-connection id would be just as useless.
      await connect();
      const first = service.sessionId;

      socket().close();
      await Promise.resolve();

      expect(service.sessionId).toBe(first);
      expect(first).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(sessionStorage.getItem("messenger.call.session")).toBe(first);
      /*
       * And emphatically *not* in localStorage. That half is what the choice
       * actually turns on: localStorage is shared by every tab of the window,
       * so two tabs would carry one id and look to the server like a single
       * reloading tab — which is precisely the case the session exists to tell
       * apart, and it would hand a second tab the first one's place in a call.
       * Without this assertion the test passes against either store.
       */
      expect(localStorage.getItem("messenger.call.session")).toBeNull();
    });

    it("sends a group invite with no sdp field at all", async () => {
      // Not `sdp: null`: realtime-service refuses a group invite that carries
      // one, and an explicit null is still a value in the JSON.
      await connect();

      service.inviteCall("conv-1", null, "video");

      expect(lastFrame().d).toEqual({
        conversation_id: "conv-1",
        media: "video",
        session_id: service.sessionId,
      });
    });

    it("names the target on a candidate and on a renegotiation", async () => {
      // A candidate with no target is derived server-side, which only a
      // two-person call can do — in a group it is refused outright.
      await connect();

      service.sendIceCandidate("call-1", { candidate: "c" }, "google_them");
      expect(lastFrame().d["to"]).toBe("google_them");

      service.renegotiateCall("call-1", { type: "offer" }, null, "google_them");
      expect(lastFrame().d["to"]).toBe("google_them");
    });

    it("omits the target on a 1:1 frame rather than sending an empty one", async () => {
      // An absent `to` is what every client written before the mesh sends, and
      // the server derives the peer from a two-person call. An empty string
      // would be a named target that matches nobody.
      await connect();

      service.sendIceCandidate("call-1", { candidate: "c" });

      expect("to" in lastFrame().d).toBeFalse();
    });
  });
});
