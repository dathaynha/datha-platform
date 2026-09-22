import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  signal,
} from "@angular/core";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { ActivatedRoute, NavigationEnd, Router } from "@angular/router";
import { TranslateModule, TranslateService } from "@ngx-translate/core";
import {
  Subject,
  debounceTime,
  distinctUntilChanged,
  filter,
  switchMap,
} from "rxjs";
import type { CallMedia, CallRecord } from "src/models/call.model";
import { conversationPreview } from "src/helper/conversation-preview";
import type { Conversation, DirectoryUser } from "src/models/messenger.model";
import { ChatDockService } from "src/services/implementations/chat-dock.service";
import { ChatStore } from "src/services/implementations/chat-store.service";
import { RealtimeService } from "src/services/implementations/realtime.service";
import { WebrtcCallService } from "src/services/implementations/webrtc-call.service";
import { conversationFaces, threadView } from "../../thread-view";
import {
  ConversationListComponent,
  type ConversationRow,
} from "../../components/conversation-list/conversation-list.component";
import {
  NewMessageDialogComponent,
  type GroupRequest,
} from "../../components/new-message-dialog/new-message-dialog.component";
import { GroupDetailsDialogComponent } from "../../components/group-details-dialog/group-details-dialog.component";
import {
  ThreadComponent,
  type ThreadRow,
} from "../../components/thread/thread.component";

/**
 * Conversation list + thread. The selected thread is a route param, so a
 * conversation is linkable and the popover can navigate straight into one.
 */
@Component({
  selector: "messenger-chats-page",
  imports: [
    TranslateModule,
    ConversationListComponent,
    ThreadComponent,
    NewMessageDialogComponent,
    GroupDetailsDialogComponent,
  ],
  templateUrl: "./chats-page.component.html",
  styleUrls: ["./chats-page.component.scss"],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "flex min-h-0 w-full flex-1" },
})
export class ChatsPageComponent {
  private readonly store = inject(ChatStore);
  private readonly dock = inject(ChatDockService);
  private readonly realtime = inject(RealtimeService);
  private readonly calls = inject(WebrtcCallService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly translate = inject(TranslateService);

  /**
   * The `chats` route itself, which is the parent of both the list ("") and the
   * thread (":id"). Navigating relative to it works identically from either,
   * and stays correct whether the remote is standalone or mounted at
   * /messenger by the shell — an absolute path would only work in one.
   */
  private readonly chatsRoot = this.route.parent ?? this.route;

  private readonly directorySearch = new Subject<string>();

  protected readonly composing = signal(false);
  protected readonly creatingGroup = signal(false);
  protected readonly detailsOpen = signal(false);
  /** A rename, add or leave is in flight; the details dialog waits on it. */
  protected readonly groupBusy = signal(false);
  /** A group action failed — shown inline, never as the global modal. */
  protected readonly groupError = signal(false);
  protected readonly attachmentError = signal(false);
  protected readonly searching = signal(false);
  protected readonly directoryResults = signal<readonly DirectoryUser[]>([]);

  protected readonly conversations = this.store.conversations;
  protected readonly activeId = this.store.activeConversationId;
  protected readonly loadingList = this.store.loadingConversations;
  protected readonly connected = this.realtime.connected;
  protected readonly loadFailed = computed(() => this.store.error() !== null);

  /**
   * Everything the open thread renders, derived from its id.
   *
   * Shared with the docked mini windows, which are the same thread on a
   * different surface — see `thread-view.ts` for why this is a factory rather
   * than a dozen computeds sitting here.
   */
  protected readonly view = threadView({
    store: this.store,
    realtime: this.realtime,
    conversationId: () => this.store.activeConversationId(),
    draftPeerId: () => this.store.draftPeerId(),
  });

  protected readonly rows = computed<readonly ConversationRow[]>(() =>
    this.conversations().map((conversation) => ({
      conversation,
      title: this.store.conversationTitle(conversation),
      preview: this.previewOf(conversation),
      // A call with no end is a call still happening. Messenger marks the row
      // the same way, so you can see where the noise is coming from without
      // opening anything. The media kind rides along so the glyph matches the
      // one the thread shows for that same call.
      ongoingCall:
        conversation.lastCall && conversation.lastCall.endedAt === null
          ? conversation.lastCall.media
          : null,
      // A group has no one presence to report, so it gets no dot.
      presence:
        conversation.type === "direct" ? this.presenceOf(conversation) : null,
      unread: conversation.unread,
      faces: conversationFaces(this.store, conversation),
    })),
  );

  protected readonly activeConversation = this.store.activeConversation;
  protected readonly draftPeerId = this.store.draftPeerId;

  /**
   * A draft has no conversation yet but still owns the stage.
   *
   * Gated on the **id**, not the loaded conversation: `openConversation` sets
   * the id synchronously and then fetches, so waiting for the detail flashed
   * the "Pick a conversation" empty state on every reload of a thread URL
   * (reported 2026-09-10).
   */
  protected readonly threadOpen = computed(
    () => this.activeId() !== null || this.draftPeerId() !== null,
  );

  constructor() {
    // Owner id comes from the access token, resolved by the store itself —
    // the id_token's `sub` is the raw provider subject and matches nothing.
    this.store.syncOwnerId();
    this.realtime.start();

    void this.store.loadConversations();

    // The open thread follows the URL, so a link, the popover and the back
    // button all take the same path into a conversation.
    //
    // Read from the snapshot rather than by subscribing to paramMap: "" and
    // ":id" are sibling routes, so switching between them destroys this
    // component and creates a second one. A paramMap subscription on the
    // *outgoing* instance emits an id-less map while the incoming instance has
    // already opened the thread — and the shared store would be cleared right
    // after being set, leaving a URL with no thread on screen. A destroyed
    // instance runs nothing, so this ordering cannot happen.
    this.applyRoute();
    this.router.events
      .pipe(
        filter((event) => event instanceof NavigationEnd),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => this.applyRoute());

    this.directorySearch
      .pipe(
        debounceTime(250),
        distinctUntilChanged(),
        switchMap((query) => {
          if (!query.trim()) {
            this.searching.set(false);
            return Promise.resolve([] as DirectoryUser[]);
          }
          this.searching.set(true);
          return this.store.searchDirectory(query);
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((results) => {
        this.directoryResults.set(results);
        this.searching.set(false);
      });
  }

  private applyRoute(): void {
    const draftPeer = this.route.snapshot.paramMap.get("ownerId");
    if (draftPeer) {
      // Same rule as picking from the dialog, for a draft opened by URL. Only
      // as good as the loaded list — a direct link followed before the list
      // arrives still opens the draft, which the idempotent create fixes on
      // the first message.
      const existing = this.store.directConversationWith(draftPeer);
      if (existing) {
        void this.router.navigate([existing], {
          relativeTo: this.chatsRoot,
          replaceUrl: true,
        });
        return;
      }
      void this.store.openDraft(draftPeer);
      return;
    }
    const id = this.route.snapshot.paramMap.get("id");
    if (id) {
      // Already open: sending the first message opens the new conversation and
      // then swaps the URL for it, and re-opening here would refetch the
      // thread the optimistic message was just rendered into.
      if (this.activeId() !== id) void this.store.openConversation(id);
    } else {
      this.store.closeActiveConversation();
    }
  }

  /**
   * Docks a conversation from the list.
   *
   * The strip drops a window for the thread this page is already showing, so
   * docking the open one has no visible effect until the user navigates away —
   * which is exactly when it starts being useful.
   */
  protected onDock(conversationId: string): void {
    this.dock.openWindow(conversationId);
  }

  protected async onSelect(conversationId: string): Promise<void> {
    await this.router.navigate([conversationId], {
      relativeTo: this.chatsRoot,
    });
  }

  protected async onBack(): Promise<void> {
    await this.router.navigate(["."], { relativeTo: this.chatsRoot });
  }

  protected onSend(body: string): void {
    const draftPeer = this.draftPeerId();
    if (draftPeer) {
      void this.sendFirst(draftPeer, body);
      return;
    }
    const id = this.activeId();
    if (!id) return;
    void this.store.sendMessage(id, body);
  }

  /**
   * Creates the conversation, posts into it, then swaps the URL for the real
   * one. `replaceUrl` so Back leaves Messenger rather than returning to a
   * draft for a conversation that now exists.
   */
  private async sendFirst(peerOwnerId: string, body: string): Promise<void> {
    const conversationId = await this.store.sendFirstMessage(peerOwnerId, body);
    if (!conversationId) return;
    await this.router.navigate([conversationId], {
      relativeTo: this.chatsRoot,
      replaceUrl: true,
    });
  }

  protected onAttach(file: File): void {
    const draftPeer = this.draftPeerId();
    if (draftPeer) {
      void this.attachFirst(draftPeer, file);
      return;
    }
    const id = this.activeId();
    if (!id) return;
    void this.store.sendAttachment(id, file);
  }

  private async attachFirst(peerOwnerId: string, file: File): Promise<void> {
    const conversationId = await this.store.sendFirstAttachment(
      peerOwnerId,
      file,
    );
    if (!conversationId) return;
    await this.router.navigate([conversationId], {
      relativeTo: this.chatsRoot,
      replaceUrl: true,
    });
  }

  /**
   * Opens an attachment. The URL is fetched on demand rather than rendered
   * into the thread: it is a short-lived SAS link, so one minted at render time
   * would be stale by the time anybody clicked it.
   */
  /** A picture's link stopped working — ask for another before giving up. */
  protected onPreviewExpired(row: ThreadRow): void {
    const conversationId = this.activeId();
    if (!conversationId) return;
    void this.store.refreshAttachmentPreview(
      conversationId,
      row.message.id,
      row.message.body,
    );
  }

  protected async onOpenAttachment(row: ThreadRow): Promise<void> {
    const id = this.activeId();
    if (!id) return;
    // Clear the last failure before trying again: neither notice had a way
    // back down, so one failed open left the banner up for the whole session.
    this.attachmentError.set(false);
    try {
      const grant = await this.store.attachmentGrant(id, row.message.id);
      window.open(grant.downloadUrl, "_blank", "noopener");
    } catch {
      this.attachmentError.set(true);
    }
  }

  protected onRetry(clientMessageId: string): void {
    const id = this.activeId();
    if (!id) return;
    void this.store.retryMessage(id, clientMessageId);
  }

  /**
   * Throttled while typing; emptying the box stops immediately.
   *
   * The stop is not throttled — it is the frame that takes the indicator off
   * the other person's screen, so delaying it is the bug.
   */
  /** Focusing or typing in the composer means the thread is being read. */
  protected onRead(): void {
    this.store.markActiveRead();
  }

  protected onTyping(active: boolean): void {
    const id = this.activeId();
    if (!id) return;
    this.store.markActiveRead();

    if (!active) {
      this.store.stopTyping(id);
      return;
    }

    // Throttled by the store, which keys it per conversation — a mini window
    // types into a different thread than this page does.
    this.store.notifyTyping(id);
  }

  protected onCompose(): void {
    this.resetDirectorySearch();
    this.composing.set(true);
  }

  protected onDirectorySearch(query: string): void {
    this.directorySearch.next(query);
  }

  /**
   * Closes the compose dialog and drops its results.
   *
   * The dialog clears its own input, but the results live here — left behind,
   * they would flash under the first keystroke of the *next* search before the
   * new response landed.
   */
  protected onCloseCompose(): void {
    this.composing.set(false);
    this.resetDirectorySearch();
  }

  protected async onPickPerson(ownerId: string): Promise<void> {
    this.onCloseCompose();
    // Someone you already talk to opens their thread. Picking a person from
    // the directory is not a request for a blank slate, and a draft over an
    // existing conversation reads as lost history (reported 2026-09-11).
    const existing = this.store.directConversationWith(ownerId);
    if (existing) {
      await this.router.navigate([existing], { relativeTo: this.chatsRoot });
      return;
    }
    // No write yet: the conversation is created by the first message, so
    // picking the wrong person costs nothing and shows them nothing.
    await this.router.navigate(["new", ownerId], {
      relativeTo: this.chatsRoot,
    });
  }

  /**
   * Creates a group, then opens it.
   *
   * The dialog is closed only on success: a failed create with the dialog gone
   * would lose the whole selection, and the error notice would arrive with
   * nothing to retry from.
   */
  protected async onCreateGroup(request: GroupRequest): Promise<void> {
    this.creatingGroup.set(true);
    const conversationId = await this.store.startGroupConversation(
      request.ownerIds,
      request.title,
    );
    this.creatingGroup.set(false);
    if (!conversationId) return;
    this.onCloseCompose();
    await this.router.navigate([conversationId], {
      relativeTo: this.chatsRoot,
    });
  }

  protected onOpenDetails(): void {
    // The directory results are shared with the compose dialog, so a stale set
    // from the last search would flash in the add-people list.
    this.resetDirectorySearch();
    this.detailsOpen.set(true);
  }

  protected onCloseDetails(): void {
    this.detailsOpen.set(false);
    this.resetDirectorySearch();
  }

  /**
   * Clears the results **and** the stream's memory of the last query.
   *
   * `distinctUntilChanged` is what makes typing cheap, and it is also what
   * made the same query silently return nothing the second time: close the
   * dialog, reopen it, type the identical text, and the search never ran while
   * the results had already been dropped. Two boxes now feed this one stream —
   * the compose dialog and the group's add-people list — so the same word in
   * both was the common case, not the corner one.
   *
   * Pushing an empty string resets that memory. It costs no request: the
   * stream short-circuits a blank query before the switchMap.
   */
  private resetDirectorySearch(): void {
    this.directoryResults.set([]);
    this.searching.set(false);
    this.directorySearch.next("");
  }

  protected async onRenameGroup(title: string): Promise<void> {
    const id = this.activeId();
    if (!id) return;
    this.groupError.set(false);
    this.groupBusy.set(true);
    const ok = await this.store.renameConversation(id, title);
    this.groupBusy.set(false);
    if (!ok) this.groupError.set(true);
  }

  protected async onAddMembers(ownerIds: readonly string[]): Promise<void> {
    const id = this.activeId();
    if (!id) return;
    this.groupError.set(false);
    this.groupBusy.set(true);
    const ok = await this.store.addParticipants(id, ownerIds);
    this.groupBusy.set(false);
    if (!ok) this.groupError.set(true);
  }

  protected async onLeaveGroup(): Promise<void> {
    const id = this.activeId();
    if (!id) return;
    this.groupError.set(false);
    this.groupBusy.set(true);
    const ok = await this.store.leaveConversation(id);
    this.groupBusy.set(false);
    if (!ok) {
      this.groupError.set(true);
      return;
    }
    this.onCloseDetails();
    // The thread is gone, so the URL must stop pointing at it.
    await this.router.navigate(["."], { relativeTo: this.chatsRoot });
  }

  /** The one-line preview under a conversation's title. */
  private previewOf(conversation: Conversation): string {
    return conversationPreview(conversation, {
      selfOwnerId: this.store.currentOwnerId(),
      displayName: (ownerId) => this.store.displayName(ownerId),
      translate: (key, params) => this.translate.instant(key, params),
    });
  }

  /**
   * Places a call in the open thread. The peer is passed for display only —
   * the server resolves the real callee from conversation membership.
   */

  /** False on a device with no camera, so video calling is not offered. */
  protected readonly hasCamera = this.calls.hasCamera;

  /**
   * Places a call in the open thread.
   *
   * The participant list is passed so the client knows whether to put an offer
   * on the invite — a mesh has no single peer to offer to. It is *not* who
   * gets rung: realtime-service resolves membership itself from the
   * conversation, because a client-chosen recipient would be a way to ring
   * strangers, and its answer comes back on `call.ringing`.
   */

  /**
   * Joins the call already happening in the open thread.
   *
   * The invited set comes off the row rather than off the conversation: the
   * server resolved it when the call was created and has authorized every
   * frame against it since, so a conversation that has gained a member in the
   * meantime must not be used to guess at it. Rows projected before phase 3
   * slice 2 carry no participants at all, hence the fallback.
   */
  protected onJoinCall(record: CallRecord): void {
    const conversation = this.activeConversation();
    const invited =
      record.participantOwnerIds.length > 0
        ? record.participantOwnerIds
        : (conversation?.participants.map((p) => p.ownerId) ?? []);
    void this.calls.joinOngoing(
      record.id,
      record.conversationId,
      record.callerOwnerId,
      invited,
      record.media,
    );
  }

  protected onStartCall(media: CallMedia = "audio"): void {
    const conversation = this.activeConversation();
    if (!conversation) return;
    void this.calls.startCall(
      conversation.id,
      conversation.participants.map((p) => p.ownerId),
      media,
    );
  }

  /** A conversation-list row's dot; the open thread's comes off the view. */
  private presenceOf(
    conversation: Conversation,
  ): "online" | "away" | "offline" {
    const ownerId = this.store.counterpart(conversation);
    return this.realtime.presence().get(ownerId)?.state ?? "offline";
  }
}
