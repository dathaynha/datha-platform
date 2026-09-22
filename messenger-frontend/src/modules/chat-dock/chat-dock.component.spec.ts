import { Component, signal } from "@angular/core";
import { TestBed, type ComponentFixture } from "@angular/core/testing";
import { provideRouter } from "@angular/router";
import { TranslateModule } from "@ngx-translate/core";
import type { CallRecord, LiveCall } from "src/models/call.model";
import type { Conversation, ThreadMessage } from "src/models/messenger.model";
import { ChatDockService } from "@services/implementations/chat-dock.service";
import { ChatStore } from "@services/implementations/chat-store.service";
import { RealtimeService } from "@services/implementations/realtime.service";
import { WebrtcCallService } from "@services/implementations/webrtc-call.service";
import { CallDockComponent } from "src/modules/call-dock/call-dock.component";
import { ChatDockComponent } from "./chat-dock.component";

const ME = "google_me";
const THEM = "google_them";

function conversation(id: string): Conversation {
  return {
    id,
    tenantId: "datha-platform",
    type: "direct",
    title: null,
    createdBy: ME,
    createdAt: "2026-09-17T09:00:00.000Z",
    lastMessageAt: "2026-09-17T10:00:00.000Z",
    lastActivityAt: "2026-09-17T10:00:00.000Z",
    participants: [
      { ownerId: ME, role: "admin", lastReadAt: null },
      { ownerId: THEM, role: "member", lastReadAt: null },
    ],
    lastMessage: null,
    lastCall: null,
    unread: false,
  };
}

function threadMessage(id: string, conversationId: string): ThreadMessage {
  return {
    id,
    conversationId,
    senderOwnerId: THEM,
    kind: "text",
    body: "hey",
    attachmentFileId: null,
    clientMessageId: id,
    createdAt: "2026-09-17T10:00:00.000Z",
    editedAt: null,
  } as ThreadMessage;
}

/**
 * Supplies data, never behaviour: what is under test here is geometry, and a
 * fake that re-derived rows or titles would be asserting against itself.
 */
class FakeStore {
  readonly activeConversationId = signal<string | null>(null);
  readonly openedThreads: [string, string][] = [];
  readonly closedThreads: [string, string][] = [];

  private readonly messages = new Map<string, readonly ThreadMessage[]>([
    // Long on purpose: a window with no definite height sizes to its content,
    // and one message is short enough to hide that completely.
    [
      "c1",
      Array.from({ length: 40 }, (_, index) =>
        threadMessage(`m1-${index}`, "c1"),
      ),
    ],
    ["c2", [threadMessage("m2", "c2")]],
    ["c3", [threadMessage("m3", "c3")]],
    ["c4", [threadMessage("m4", "c4")]],
  ]);

  attachmentPreviews = () => new Map<string, string>();
  attachmentAspects = () => new Map<string, number>();

  conversationById = (id: string | null) => (id ? conversation(id) : null);
  conversationTitle = () => "Dat Ha";
  counterpart = () => THEM;
  displayName = (id: string) => (id === THEM ? "Dat Ha" : "Me");
  initialOf = () => "D";
  pictureUrl = () => "";
  currentOwnerId = () => ME;
  isAdminOf = () => true;
  readersOf = (): readonly string[] => [];
  loadingOf = () => false;
  typistsOf = (): readonly string[] => [];
  messagesOf = (id: string | null) => (id ? (this.messages.get(id) ?? []) : []);
  callsOf = (): readonly CallRecord[] => [];
  ongoingCallOf = (): CallRecord | null => null;
  ensurePerson = () => Promise.resolve();
  ensureAttachmentPreview = () => Promise.resolve();
  refreshAttachmentPreview = () => Promise.resolve();
  attachmentGrant = () => Promise.reject(new Error("not used"));
  sendMessage = () => Promise.resolve();
  sendAttachment = () => Promise.resolve();
  retryMessage = () => Promise.resolve();
  markRead = () => {};
  notifyTyping = () => {};
  stopTyping = () => {};

  openThread = (id: string, holder: string) => {
    this.openedThreads.push([id, holder]);
    return Promise.resolve();
  };
  closeThread = (id: string, holder: string) => {
    this.closedThreads.push([id, holder]);
  };
}

class FakeRealtime {
  connected = signal(true);
  presence = () => new Map();
  typing = () => [];
}

class FakeCalls {
  readonly call = signal<LiveCall | null>(null);
  readonly error = signal<string | null>(null);
  readonly endNotice = signal<null>(null);
  readonly hasCamera = signal(true);
  readonly localStream = signal<MediaStream | null>(null);
  readonly localScreen = signal<MediaStream | null>(null);
  readonly peers = signal<readonly never[]>([]);
  readonly isGroupCall = signal(false);
  readonly peerOwnerId = signal(THEM);
  readonly hasVideo = signal(false);
  readonly diagnostics = signal(null);
  accept(): Promise<void> {
    return Promise.resolve();
  }
  clearEndNotice(): void {}
  hangUp(): void {}
  toggleMute(): void {}
  toggleCamera(): void {}
  useCamera(): Promise<void> {
    return Promise.resolve();
  }
  promoteToVideo(): Promise<void> {
    return Promise.resolve();
  }
  toggleScreenShare(): Promise<void> {
    return Promise.resolve();
  }
}

const liveCall = (): LiveCall => ({
  callId: "call-1",
  conversationId: "c9",
  participantIds: [ME, THEM],
  callerOwnerId: ME,
  joinedIds: [ME, THEM],
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

/** Both corner overlays at once, which is the only way to measure the gap. */
@Component({
  selector: "dock-host",
  imports: [ChatDockComponent, CallDockComponent],
  template: `<messenger-chat-dock /><messenger-call-dock />`,
})
class DockHostComponent {}

describe("ChatDockComponent", () => {
  let fixture: ComponentFixture<DockHostComponent>;
  let dock: ChatDockService;
  let store: FakeStore;
  let calls: FakeCalls;

  const query = (selector: string): HTMLElement | null =>
    document.body.querySelector(selector);

  beforeEach(() => {
    localStorage.removeItem("messengerChatDock");
    store = new FakeStore();
    calls = new FakeCalls();
    TestBed.configureTestingModule({
      imports: [DockHostComponent, TranslateModule.forRoot()],
      providers: [
        provideRouter([]),
        { provide: ChatStore, useValue: store },
        { provide: RealtimeService, useValue: new FakeRealtime() },
        { provide: WebrtcCallService, useValue: calls },
      ],
    });
    dock = TestBed.inject(ChatDockService);
    fixture = TestBed.createComponent(DockHostComponent);
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
    localStorage.removeItem("messengerChatDock");
  });

  it("renders nothing until a conversation is docked", () => {
    expect(query("[data-testid='chat-dock']")).toBeNull();
  });

  /**
   * The rule that cost three "the stage is blank" reports on 2026-09-16: an
   * element can be present, correct and invisible. A window whose height is
   * `auto` inside a flex column has nothing for its scroller to scroll
   * against, so the thread grows past the viewport and takes the composer with
   * it — every structural assertion still passing.
   */
  it("bounds a window's height however long the thread is", () => {
    dock.openWindow("c1");
    fixture.detectChanges();

    const element = query("messenger-chat-window");
    expect(element).not.toBeNull();
    const box = element!.getBoundingClientRect();
    expect(box.width).toBeGreaterThan(200);
    expect(box.height).toBeGreaterThan(200);
    // The messages scroll; the window does not grow to hold them.
    expect(box.height).toBeLessThan(window.innerHeight);

    const composer = element!
      .querySelector("[data-testid='composer-input']")!
      .getBoundingClientRect();
    expect(composer.height).toBeGreaterThan(0);
    // Inside the window, not pushed out of the bottom of it and off screen.
    expect(composer.bottom).toBeLessThanOrEqual(box.bottom + 1);
    expect(composer.bottom).toBeLessThanOrEqual(window.innerHeight + 1);
  });

  it("collapses to a bar that is shorter than the window", () => {
    dock.openWindow("c1");
    fixture.detectChanges();
    const open = query("messenger-chat-window")!.getBoundingClientRect().height;

    dock.setMinimised("c1", true);
    fixture.detectChanges();
    const collapsed = query("messenger-chat-window")!.getBoundingClientRect()
      .height;

    expect(collapsed).toBeLessThan(open);
    expect(collapsed).toBeGreaterThan(0);
    expect(query("[data-testid='dock-bar-title']")).not.toBeNull();
  });

  /**
   * Both overlays live in the bottom-right corner and have to agree about it
   * without measuring each other — they share `dock.$width`.
   */
  it("clears the corner the call dock occupies", () => {
    dock.openWindow("c1");
    calls.call.set(liveCall());
    fixture.detectChanges();

    const strip = query("[data-testid='chat-dock']")!.getBoundingClientRect();
    const callDock = query(
      "[data-testid='call-dock']",
    )!.getBoundingClientRect();
    expect(callDock.width).toBeGreaterThan(0);
    expect(strip.right).toBeLessThanOrEqual(callDock.left);
  });

  it("takes the whole corner back when the call ends", () => {
    dock.openWindow("c1");
    calls.call.set(liveCall());
    fixture.detectChanges();
    const shifted = query("[data-testid='chat-dock']")!.getBoundingClientRect()
      .right;

    calls.call.set(null);
    fixture.detectChanges();
    const restored = query("[data-testid='chat-dock']")!.getBoundingClientRect()
      .right;

    expect(restored).toBeGreaterThan(shifted);
  });

  it("does not draw a window for the thread the page is already showing", () => {
    dock.openWindow("c1");
    dock.openWindow("c2");
    store.activeConversationId.set("c1");
    fixture.detectChanges();

    const titles = document.body.querySelectorAll("messenger-chat-window");
    expect(titles.length).toBe(1);
    // Dropped from the strip, not closed: it is still a holder on the thread.
    expect(store.closedThreads).toEqual([]);
    expect(dock.windows().length).toBe(2);
  });
});
