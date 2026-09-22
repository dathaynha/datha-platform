import { TestBed } from "@angular/core/testing";
import { LOCAL_STORAGE_KEY } from "@constants/index";
import { ChatStore } from "./chat-store.service";
import { ChatDockService, MAX_DOCKED_WINDOWS } from "./chat-dock.service";

const OWNER = "google_me";
const OTHER_OWNER = "google_someone_else";

/** The key the service writes under, for a given signed-in user. */
const keyFor = (ownerId: string) => `${LOCAL_STORAGE_KEY.CHAT_DOCK}:${ownerId}`;

/** Records the holder calls, which is the whole of this service's contract. */
class FakeStore {
  readonly opened: [string, string][] = [];
  readonly closed: [string, string][] = [];
  readonly reads: (string | null)[] = [];
  ownerId = OWNER;

  syncOwnerId = () => {};
  currentOwnerId = () => this.ownerId;

  openThread = (id: string, holder: string) => {
    this.opened.push([id, holder]);
    return Promise.resolve();
  };
  closeThread = (id: string, holder: string) => {
    this.closed.push([id, holder]);
  };
  markRead = (id: string | null) => {
    this.reads.push(id);
  };
}

describe("ChatDockService", () => {
  let store: FakeStore;

  const build = (ownerId: string = OWNER): ChatDockService => {
    store = new FakeStore();
    store.ownerId = ownerId;
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: ChatStore, useValue: store }],
    });
    return TestBed.inject(ChatDockService);
  };

  const clearStorage = () => {
    for (const ownerId of [OWNER, OTHER_OWNER]) {
      localStorage.removeItem(keyFor(ownerId));
    }
  };

  beforeEach(clearStorage);
  afterEach(clearStorage);

  it("holds the thread open for as long as its window is", () => {
    const dock = build();
    dock.openWindow("c1");
    expect(store.opened).toEqual([["c1", "dock:c1"]]);

    dock.closeWindow("c1");
    expect(store.closed).toEqual([["c1", "dock:c1"]]);
  });

  it("raises an already-docked conversation instead of docking it twice", () => {
    const dock = build();
    dock.openWindow("c1");
    dock.setMinimised("c1", true);

    dock.openWindow("c1");

    expect(dock.windows().length).toBe(1);
    expect(dock.windows()[0].minimised).toBeFalse();
    // One subscription, not two — a second `openThread` for the same holder
    // would be a no-op in the store, but asking for it hides the intent.
    expect(store.opened.length).toBe(1);
  });

  /**
   * The cap is a width limit and a rate limit at once: `conversation.open`
   * draws on realtime-service's tighter token bucket (burst 5), and a
   * reconnect re-sends one frame per remembered thread.
   */
  it("drops the oldest window rather than refusing the newest", () => {
    const dock = build();
    for (let index = 1; index <= MAX_DOCKED_WINDOWS + 1; index += 1) {
      dock.openWindow(`c${index}`);
    }

    expect(dock.windows().length).toBe(MAX_DOCKED_WINDOWS);
    expect(dock.windows().map((w) => w.conversationId)).not.toContain("c1");
    expect(dock.windows().map((w) => w.conversationId)).toContain(
      `c${MAX_DOCKED_WINDOWS + 1}`,
    );
    // The evicted window let go of its thread; it is not left subscribed.
    expect(store.closed).toEqual([["c1", "dock:c1"]]);
  });

  it("puts the same windows back after a reload", () => {
    const first = build();
    first.openWindow("c1");
    first.openWindow("c2");
    first.setMinimised("c2", true);

    // A new instance is what a reload produces.
    const second = build();
    expect(second.windows().map((w) => w.conversationId)).toEqual(["c1", "c2"]);
    expect(second.windows()[1].minimised).toBeTrue();
    // And it re-takes the subscriptions, or the restored windows would render
    // a thread nothing is feeding.
    expect(store.opened).toEqual([
      ["c1", "dock:c1"],
      ["c2", "dock:c2"],
    ]);
  });

  it("survives storage holding something it did not write", () => {
    localStorage.setItem(keyFor(OWNER), "not json at all");
    const dock = build();
    expect(dock.windows()).toEqual([]);
  });

  /**
   * `clearAuthData` on logout removes the session keys and knows nothing about
   * this one, so a single shared key handed the next person to sign in on this
   * browser the previous person's conversations. Every fetch would then be
   * refused and the windows would render blank — a confusing way to find out.
   */
  it("does not restore one user's windows for the next user", () => {
    const first = build(OWNER);
    first.openWindow("c1");
    first.openWindow("c2");
    expect(first.windows().length).toBe(2);

    const second = build(OTHER_OWNER);
    expect(second.windows()).toEqual([]);
    expect(store.opened).toEqual([]);

    // And the first user's windows are still there when they come back —
    // clearing the key on logout would have thrown them away instead.
    const back = build(OWNER);
    expect(back.windows().map((w) => w.conversationId)).toEqual(["c1", "c2"]);
  });

  it("marks a thread read when its window is expanded again", () => {
    const dock = build();
    dock.openWindow("c1");
    dock.setMinimised("c1", true);
    store.reads.length = 0;

    dock.setMinimised("c1", false);
    expect(store.reads).toEqual(["c1"]);
  });
});
