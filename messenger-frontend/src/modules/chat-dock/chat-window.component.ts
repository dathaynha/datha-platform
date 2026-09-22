import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
} from "@angular/core";
import { Router } from "@angular/router";
import { TranslateModule } from "@ngx-translate/core";
import type { CallMedia, CallRecord } from "src/models/call.model";
import { ChatDockService } from "@services/implementations/chat-dock.service";
import { ChatStore } from "@services/implementations/chat-store.service";
import { RealtimeService } from "@services/implementations/realtime.service";
import { WebrtcCallService } from "@services/implementations/webrtc-call.service";
import { AvatarStackComponent } from "src/modules/shared/avatar-stack/avatar-stack.component";
import {
  ThreadComponent,
  type ThreadRow,
} from "src/modules/chats/components/thread/thread.component";
import { threadView } from "src/modules/chats/thread-view";

/**
 * One docked conversation.
 *
 * The thread inside it is the **same** `ThreadComponent` the chats page
 * renders, driven by the same `threadView` over this window's conversation id.
 * Nothing about a message, a run, a separator, a call row, a read marker or a
 * typing indicator is decided twice.
 *
 * A component per window rather than a loop inside the strip because
 * `threadView` opens computeds and an effect, which need one injection context
 * each — and because a window is genuinely an instance of something, with its
 * own scroll position and its own draft.
 */
@Component({
  selector: "messenger-chat-window",
  imports: [TranslateModule, ThreadComponent, AvatarStackComponent],
  templateUrl: "./chat-window.component.html",
  styleUrls: ["./chat-window.component.scss"],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: "chat-window flex flex-col",
    "[class.is-minimised]": "minimised()",
  },
})
export class ChatWindowComponent {
  readonly conversationId = input.required<string>();
  /** Collapsed to its title bar. Still open, still subscribed, still read. */
  readonly minimised = input(false);
  /**
   * Where this app's chats live: `/chats` standalone, `/messenger/chats` when
   * the shell hosts the remote. Passed down rather than detected, because the
   * answer belongs to whoever mounted the dock and a remote has to work in
   * both places.
   */
  readonly chatsLink = input<readonly string[]>(["/chats"]);

  private readonly store = inject(ChatStore);
  private readonly realtime = inject(RealtimeService);
  private readonly calls = inject(WebrtcCallService);
  private readonly dock = inject(ChatDockService);
  private readonly router = inject(Router);

  protected readonly view = threadView({
    store: this.store,
    realtime: this.realtime,
    conversationId: () => this.conversationId(),
  });

  protected readonly connected = this.realtime.connected;
  protected readonly hasCamera = this.calls.hasCamera;

  /** Drives the dot on a collapsed bar — the only unread signal it has room for. */
  protected readonly unread = computed(
    () => this.store.conversationById(this.conversationId())?.unread ?? false,
  );

  protected onExpand(): void {
    this.dock.setMinimised(this.conversationId(), false);
  }

  protected onMinimise(): void {
    this.dock.setMinimised(this.conversationId(), true);
  }

  protected onClose(): void {
    this.dock.closeWindow(this.conversationId());
  }

  protected onSend(body: string): void {
    void this.store.sendMessage(this.conversationId(), body);
  }

  protected onAttach(file: File): void {
    void this.store.sendAttachment(this.conversationId(), file);
  }

  protected onRetry(clientMessageId: string): void {
    void this.store.retryMessage(this.conversationId(), clientMessageId);
  }

  protected onRead(): void {
    this.store.markRead(this.conversationId());
  }

  protected onTyping(active: boolean): void {
    const id = this.conversationId();
    this.store.markRead(id);
    if (!active) {
      this.store.stopTyping(id);
      return;
    }
    this.store.notifyTyping(id);
  }

  protected onPreviewExpired(row: ThreadRow): void {
    void this.store.refreshAttachmentPreview(
      this.conversationId(),
      row.message.id,
      row.message.body,
    );
  }

  /**
   * Opens an attachment. A failure is silent here, unlike on the page: a
   * 320px window has nowhere to put a notice that does not cover the thread,
   * and the file card stays clickable.
   */
  protected async onOpenAttachment(row: ThreadRow): Promise<void> {
    try {
      const grant = await this.store.attachmentGrant(
        this.conversationId(),
        row.message.id,
      );
      window.open(grant.downloadUrl, "_blank", "noopener");
    } catch {
      // Nothing to show; the card can be clicked again.
    }
  }

  protected onStartCall(media: CallMedia = "audio"): void {
    const conversation = this.view.conversation();
    if (!conversation) return;
    void this.calls.startCall(
      conversation.id,
      conversation.participants.map((p) => p.ownerId),
      media,
    );
  }

  /**
   * Joins the call already happening in this thread.
   *
   * The invited set comes off the row rather than off the conversation: the
   * server resolved it when the call was created and has authorized every
   * frame against it since, so a conversation that has gained a member in the
   * meantime must not be used to guess at it.
   */
  protected onJoinCall(record: CallRecord): void {
    const conversation = this.view.conversation();
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

  /**
   * A group's details open the full thread instead of a dialog.
   *
   * Members, rename, add and leave inside a 320px window would be a second
   * copy of the details dialog's handlers for a surface nobody administers a
   * group from. Messenger does the same: the window's header takes you to the
   * conversation.
   */
  protected onDetails(): void {
    void this.router.navigate([...this.chatsLink(), this.conversationId()]);
  }
}
