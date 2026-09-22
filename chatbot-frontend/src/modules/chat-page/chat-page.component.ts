import { HttpErrorResponse } from "@angular/common/http";
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  HostListener,
  inject,
  Injector,
  NgZone,
  OnInit,
  signal,
  viewChild,
} from "@angular/core";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { ActivatedRoute, Router } from "@angular/router";
import {
  CHAT_MODEL_SERVICE_INJECTOR,
  CONVERSATION_SERVICE_INJECTOR,
  FILE_SERVICE_INJECTOR,
  MESSAGE_SERVICE_INJECTOR,
  MESSAGE_STREAM_SERVICE_INJECTOR,
} from "@constants/injection-token.constant";
import {
  DEFAULT_CHAT_MODEL_ID,
  FALLBACK_CHAT_MODELS,
  MAX_CHAT_ATTACHMENTS,
  MAX_CHAT_ATTACHMENT_BYTES,
  SIDEBAR_CONVERSATIONS_PAGE_SIZE,
  SIDEBAR_LOAD_MORE_NEAR_BOTTOM_PX,
  THREAD_JUMP_TO_BOTTOM_GAP_PX,
  THREAD_LOAD_OLDER_SCROLL_TOP_PX,
  CONVERSATION_QUERY_PARAM,
  THREAD_MESSAGE_PAGE_SIZE,
  THREAD_PIN_BOTTOM_RELEASE_GAP_PX,
  UPLOAD_CONCURRENCY,
} from "@constants/chat-page.constant";
import { LOCAL_STORAGE_KEY } from "@constants/local-storage.constant";
import type {
  ConversationSummaryDto,
  HistoryMessageDto,
  HistoryMessagesPageDto,
} from "@models/chat-history.model";
import type {
  ChatBubble,
  ComposerAttachmentRow,
} from "@models/chat-page.model";
import type {
  MessageFileAttachPayload,
  MessageJobResponse,
  MessageStreamDoneEvent,
  MessageStreamEvent,
} from "@models/message-job.model";
import type { ConfirmDialogModel } from "@models/dialog.model";
import { FormsModule } from "@angular/forms";
import { TranslateModule, TranslateService } from "@ngx-translate/core";
import { ChatModelService } from "@services/implementations/chatbot/chat-model.service";
import { ConversationService } from "@services/implementations/chatbot/conversation.service";
import { MessageStreamService } from "@services/implementations/chatbot/message-stream.service";
import { MessageService } from "@services/implementations/chatbot/message.service";
import type { ChatModelOptionDto } from "@models/chat-model.model";
import { FileService } from "@services/implementations/file-service/file-service.service";
import { ConfirmationDialogComponent } from "@datha/platform-ui";
import { ButtonModule } from "primeng/button";
import { DialogService } from "primeng/dynamicdialog";
import {
  catchError,
  EMPTY,
  finalize,
  from,
  map,
  mergeMap,
  Observable,
  of,
  Subject,
  switchMap,
  takeUntil,
  tap,
  TimeoutError,
} from "rxjs";

import { StreamChunkBatcher } from "@helper/stream-chunk-batcher.helper";

import {
  createImagePreviewObjectUrl,
  renderPdfFirstPageDataUrl,
} from "./attachment-preview";
import {
  attachmentIconClass as attachmentIconClassForMime,
  attachmentKind as classifyAttachmentMime,
  attachmentKindFromMimeAndName,
  type AttachmentKind,
} from "./attachment-meta";
import { ChatThreadAttachmentComponent } from "./chat-thread-attachment.component";

@Component({
  selector: "app-chat-page",
  imports: [
    TranslateModule,
    ButtonModule,
    FormsModule,
    ChatThreadAttachmentComponent,
  ],
  providers: [
    { provide: MESSAGE_SERVICE_INJECTOR, useClass: MessageService },
    {
      provide: MESSAGE_STREAM_SERVICE_INJECTOR,
      useClass: MessageStreamService,
    },
    { provide: CONVERSATION_SERVICE_INJECTOR, useClass: ConversationService },
    { provide: CHAT_MODEL_SERVICE_INJECTOR, useClass: ChatModelService },
    { provide: FILE_SERVICE_INJECTOR, useClass: FileService },
  ],
  templateUrl: "./chat-page.component.html",
  styleUrls: ["./chat-page.theme.scss", "./chat-page.component.scss"],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    // The gap and padding that used to be `sm:gap-3 sm:p-3` are in the
    // stylesheet now: they key on `cb-page`, and an element cannot query a
    // container it declares itself.
    class: "flex h-full min-h-0 min-w-0 w-full flex-1 flex-row overflow-hidden",
  },
})
export class ChatPageComponent implements OnInit {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly messages = inject(MESSAGE_SERVICE_INJECTOR);
  private readonly messageStream = inject(MESSAGE_STREAM_SERVICE_INJECTOR);
  private readonly conversationApi = inject(CONVERSATION_SERVICE_INJECTOR);
  private readonly chatModelsApi = inject(CHAT_MODEL_SERVICE_INJECTOR);
  private readonly fileApi = inject(FILE_SERVICE_INJECTOR);
  private readonly ngZone = inject(NgZone);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);
  private readonly dialogService = inject(DialogService);
  private readonly translate = inject(TranslateService);
  private readonly threadRef = viewChild<ElementRef<HTMLElement>>("threadEl");
  /** Wraps scrollable column content; its block size grows (ResizeObserver target — `#threadEl` does not). */
  private readonly threadScrollContentRef = viewChild<ElementRef<HTMLElement>>(
    "threadScrollContentEl",
  );
  private readonly draftArea =
    viewChild<ElementRef<HTMLTextAreaElement>>("draftEl");
  private readonly fileInputRef =
    viewChild<ElementRef<HTMLInputElement>>("fileInputEl");
  private readonly modelPickerRef =
    viewChild<ElementRef<HTMLElement>>("modelPickerEl");
  private readonly modelSearchInputRef =
    viewChild<ElementRef<HTMLInputElement>>("modelSearchInput");

  /** Upload pipeline rows (stable order; preview URLs are local only). */
  readonly attachedFiles = signal<readonly ComposerAttachmentRow[]>([]);
  readonly fileUploadBusy = signal(false);
  readonly maxChatAttachments = MAX_CHAT_ATTACHMENTS;

  /** Aborts in-flight POST / SSE when starting a new chat, clearing, or switching threads. */
  private readonly cancelOutbound$ = new Subject<void>();

  /** Bumped on new chat / clear / new selection so stale message fetches cannot repaint the thread. */
  private threadLoadSeq = 0;

  /** One paint per frame for streamed text, instead of one per SSE chunk. */
  private readonly chunkBatcher = new StreamChunkBatcher((batched) =>
    this.applyBatchedChunks(batched),
  );

  /** After opening history, keep clamping scroll to bottom while layout shifts (previews/errors). */
  private threadPinBottomActive = false;
  private threadLayoutPinObserver: ResizeObserver | null = null;
  private layoutPinScrollRaf = 0;
  private scrollToEndRaf = 0;

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.revokeBlobPreviews(this.attachedFiles());
      this.chunkBatcher.cancelPending();
      if (this.scrollToEndRaf !== 0) {
        cancelAnimationFrame(this.scrollToEndRaf);
      }
      this.cancelOutbound$.complete();
      this.teardownThreadLayoutPin();
    });

    // Rotate the thinking-stage word while the typing bubble is on screen.
    effect((onCleanup) => {
      if (!this.showTyping() || this.pendingStage() !== "thinking") {
        return;
      }
      const timer = setInterval(
        () => this.pendingTick.update((t) => t + 1),
        2000,
      );
      onCleanup(() => clearInterval(timer));
    });
  }

  /** Backend conversation id; sent on follow-up turns. */
  readonly conversationId = signal<string | null>(null);

  /**
   * Whether the history pane is showing instead of the chat — compact only.
   *
   * Below `sm` the two panes cannot share 390px: the stage was left with
   * ~110px, which wrapped its empty state to one word per line (measured
   * 2026-09-17). Above `sm` this signal is inert, because both panes are
   * rendered side by side regardless of it.
   */
  readonly historyOpen = signal(false);

  readonly draft = signal("");
  readonly bubbles = signal<readonly ChatBubble[]>([]);
  readonly busy = signal(false);

  /**
   * The empty assistant placeholder (streamed into chunk by chunk) stays in
   * state for the stream handler but never renders — until its first chunk
   * the typing indicator is the only pending visual.
   */
  readonly visibleBubbles = computed(() =>
    this.bubbles().filter((b) => !(b.role === "assistant" && b.text === "")),
  );

  /** Typing dots only between send and the first streamed chunk. */
  readonly showTyping = computed(() => {
    if (!this.busy()) {
      return false;
    }
    const list = this.visibleBubbles();
    const last = list[list.length - 1];
    return !(last && last.role === "assistant");
  });

  /**
   * Id of the error bubble that may offer "Try again" — only the newest turn, and
   * only while nothing is generating (`retry-last` returns 409 otherwise).
   */
  readonly retryBubbleId = computed(() => {
    if (this.busy()) {
      return null;
    }
    const list = this.visibleBubbles();
    const last = list[list.length - 1];
    return last && last.role === "error" && last.retryable ? last.id : null;
  });

  /** Real pipeline stage: queued = job posted, thinking = worker claimed it,
   * retrying = provider blip, worker waiting to try again before any chunk. */
  readonly pendingStage = signal<"queued" | "thinking" | "retrying">("queued");
  private readonly pendingTick = signal(0);
  private readonly retryProgress = signal<{
    attempt: number;
    max: number;
  } | null>(null);

  readonly pendingLabel = computed(() => {
    const retry = this.retryProgress();
    if (this.pendingStage() === "retrying" && retry) {
      return this.translate.instant("CHAT.PENDING_RETRYING", {
        attempt: retry.attempt,
        max: retry.max,
      }) as string;
    }
    if (this.pendingStage() === "queued") {
      return this.translate.instant("CHAT.PENDING_QUEUED") as string;
    }
    const words: unknown = this.translate.instant("CHAT.PENDING_WORDS");
    if (Array.isArray(words) && words.length > 0) {
      return String(words[this.pendingTick() % words.length]);
    }
    return this.translate.instant("CHAT.LOADING") as string;
  });

  readonly conversations = signal<readonly ConversationSummaryDto[]>([]);
  readonly sidebarListLoading = signal(false);
  readonly sidebarListError = signal(false);
  readonly sidebarLoadingMore = signal(false);
  readonly sidebarHasMore = signal(true);
  readonly sidebarMoreFailed = signal(false);
  readonly historyThreadLoading = signal(false);
  readonly historyThreadError = signal(false);

  readonly renamingConversationId = signal<string | null>(null);
  /** Bound with `ngModel` while the sidebar rename row is open. */
  renameBuffer = "";
  readonly renameSaving = signal(false);
  readonly renameFailed = signal(false);

  readonly deletingConversation = signal(false);

  readonly chatModelOptions = signal<ChatModelOptionDto[]>([]);
  readonly chatModelsLoading = signal(true);
  readonly selectedChatModel = signal(DEFAULT_CHAT_MODEL_ID);
  readonly modelMenuOpen = signal(false);
  readonly modelMenuQuery = signal("");

  /** True while the user is scrolled far enough up to want a way back down. */
  readonly showJumpToBottom = signal(false);

  /** Pagination for thread history (cursor = oldest loaded server message id). */
  readonly threadHasMoreOlder = signal(false);
  readonly threadOlderLoading = signal(false);
  readonly threadOlderLoadFailed = signal(false);
  readonly threadOldestMessageId = signal<string | null>(null);

  ngOnInit(): void {
    this.loadChatModels();
    this.refreshConversationList();

    /*
     * The open conversation follows the URL, so a reload, a bookmark and the
     * back button all land on the thread you were reading rather than on a
     * blank new chat (dathq, 2026-09-21).
     *
     * A query param rather than a `/chat/:id` segment, which is what ChatGPT
     * and Claude put in the URL. Angular reuses a component only when the
     * route config is the same object, so `chat` and `chat/:id` as siblings
     * would **destroy and recreate this page** on every switch — and this
     * component, not a store, owns the SSE stream, the chunk batcher, the
     * conversation list and the attachment set. `messenger-frontend` can
     * afford the segment because its state lives in `ChatStore`; hoisting
     * this page's state is the work that would make the nicer URL free, and
     * it is not this change.
     *
     * Subscribing rather than reading the snapshot is right *because* the
     * component survives: the param changes under a live instance, which is
     * what makes back and forward move between threads. (Messenger reads the
     * snapshot for the opposite reason — there the instance is replaced.)
     */
    this.route.queryParamMap
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((params) => {
        const id = params.get(CONVERSATION_QUERY_PARAM);
        if (id === this.conversationId()) {
          return;
        }
        if (id) {
          this.selectConversation(id);
        } else if (this.conversationId() !== null) {
          this.clearThread();
        }
      });
  }

  /**
   * Writes the open conversation into the URL.
   *
   * Every `conversationId` write goes through here — selecting a thread,
   * clearing it, and the send that *creates* one (a first message would
   * otherwise be lost on reload, which is the same bug one step later).
   * Skipped when the URL already says this, so the subscription above cannot
   * feed itself.
   */
  private syncConversationParam(id: string | null): void {
    if (
      this.route.snapshot.queryParamMap.get(CONVERSATION_QUERY_PARAM) === id
    ) {
      return;
    }
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { [CONVERSATION_QUERY_PARAM]: id },
      queryParamsHandling: "merge",
    });
  }

  private loadChatModels(): void {
    this.chatModelsLoading.set(true);
    this.chatModelsApi
      .listModels()
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        catchError(() =>
          of({
            models: [...FALLBACK_CHAT_MODELS],
            default_model: DEFAULT_CHAT_MODEL_ID,
          }),
        ),
        finalize(() => this.chatModelsLoading.set(false)),
      )
      .subscribe((res) => {
        this.chatModelOptions.set(this.mapPickerOptions(res.models));
        const stored = localStorage.getItem(
          LOCAL_STORAGE_KEY.SELECTED_CHAT_MODEL,
        );
        const ids = new Set(res.models.map((m) => m.id));
        const pick =
          stored && ids.has(stored)
            ? stored
            : ids.has(res.default_model)
              ? res.default_model
              : (res.models[0]?.id ?? DEFAULT_CHAT_MODEL_ID);
        this.selectedChatModel.set(pick);
      });
  }

  onChatModelChange(modelId: string): void {
    this.selectedChatModel.set(modelId);
    localStorage.setItem(LOCAL_STORAGE_KEY.SELECTED_CHAT_MODEL, modelId);
  }

  selectedModelLabel(): string {
    const id = this.selectedChatModel();
    const match = this.chatModelOptions().find((m) => m.id === id);
    return match?.display_name ?? id;
  }

  toggleModelMenu(ev: MouseEvent): void {
    ev.stopPropagation();
    if (
      this.busy() ||
      this.historyThreadLoading() ||
      this.chatModelsLoading()
    ) {
      return;
    }
    const opening = !this.modelMenuOpen();
    this.modelMenuOpen.set(opening);
    if (opening) {
      this.modelMenuQuery.set("");
      requestAnimationFrame(() => {
        this.modelSearchInputRef()?.nativeElement.focus();
      });
    } else {
      this.modelMenuQuery.set("");
    }
  }

  filteredModelOptions(): readonly ChatModelOptionDto[] {
    const q = this.modelMenuQuery().trim().toLowerCase();
    if (!q) {
      return this.chatModelOptions();
    }
    return this.chatModelOptions().filter(
      (m) =>
        m.display_name.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q),
    );
  }

  onModelMenuQueryInput(value: string): void {
    this.modelMenuQuery.set(value);
  }

  pickModel(modelId: string): void {
    this.onChatModelChange(modelId);
    this.modelMenuOpen.set(false);
    this.modelMenuQuery.set("");
  }

  @HostListener("document:click", ["$event"])
  onDocumentClick(ev: MouseEvent): void {
    if (!this.modelMenuOpen()) {
      return;
    }
    const root = this.modelPickerRef()?.nativeElement;
    if (root && !root.contains(ev.target as Node)) {
      this.modelMenuOpen.set(false);
      this.modelMenuQuery.set("");
    }
  }

  @HostListener("document:keydown.escape")
  closeModelMenu(): void {
    this.modelMenuOpen.set(false);
    this.modelMenuQuery.set("");
  }

  /** Shorter labels so the in-composer select stays compact. */
  private mapPickerOptions(
    models: readonly ChatModelOptionDto[],
  ): ChatModelOptionDto[] {
    return models.map((m) => ({
      ...m,
      display_name: this.shortModelDisplayName(m.display_name, m.id),
    }));
  }

  private shortModelDisplayName(display: string, id: string): string {
    let label = (display || id).trim().replace(/^Gemini\s+/i, "");
    if (label.length > 30) {
      label = `${label.slice(0, 27)}…`;
    }
    return label || id;
  }

  onDraftInput(value: string): void {
    this.draft.set(value);
    const ta = this.draftArea()?.nativeElement;
    if (!ta) {
      return;
    }
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 144)}px`;
  }

  /** Enter sends; Shift+Enter inserts a newline (IME composition left alone). */
  onComposerKeydown(ev: KeyboardEvent): void {
    if (ev.key === "Escape" && this.modelMenuOpen()) {
      ev.preventDefault();
      this.modelMenuOpen.set(false);
      return;
    }
    if (ev.key !== "Enter" || ev.isComposing) {
      return;
    }
    if (ev.shiftKey) {
      return;
    }
    ev.preventDefault();
    this.send();
  }

  clearThread(): void {
    this.threadPinBottomActive = false;
    this.teardownThreadLayoutPin();
    this.cancelOutbound$.next();
    this.chunkBatcher.cancelPending();
    this.showJumpToBottom.set(false);
    this.threadLoadSeq++;
    this.historyThreadLoading.set(false);
    this.historyThreadError.set(false);
    this.bubbles.set([]);
    this.conversationId.set(null);
    this.syncConversationParam(null);
    this.threadHasMoreOlder.set(false);
    this.threadOldestMessageId.set(null);
    this.threadOlderLoading.set(false);
    this.threadOlderLoadFailed.set(false);
  }

  /** Always runs: cancels any in-flight send/stream, then clears state (even while `busy()`). */
  newChat(): void {
    this.historyOpen.set(false);
    this.clearThread();
    this.busy.set(false);
    this.revokeBlobPreviews(this.attachedFiles());
    this.attachedFiles.set([]);
    this.draft.set("");
    requestAnimationFrame(() => {
      const ta = this.draftArea()?.nativeElement;
      if (ta) {
        ta.value = "";
        ta.style.height = "auto";
      }
    });
  }

  refreshConversationList(): void {
    this.sidebarListLoading.set(true);
    this.sidebarListError.set(false);
    this.sidebarMoreFailed.set(false);
    this.sidebarHasMore.set(true);
    this.conversationApi
      .list(SIDEBAR_CONVERSATIONS_PAGE_SIZE, 0)
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        catchError(() => {
          this.sidebarListError.set(true);
          return of([] as const);
        }),
        finalize(() => this.sidebarListLoading.set(false)),
      )
      .subscribe((rows) => {
        this.conversations.set(rows);
        this.sidebarHasMore.set(
          rows.length === SIDEBAR_CONVERSATIONS_PAGE_SIZE,
        );
      });
  }

  /** Infinite scroll / explicit control: next page of sidebar conversations. */
  loadMoreSidebarConversations(): void {
    if (
      !this.sidebarHasMore() ||
      this.sidebarLoadingMore() ||
      this.sidebarListLoading() ||
      this.sidebarListError()
    ) {
      return;
    }
    const offset = this.conversations().length;
    this.sidebarLoadingMore.set(true);
    this.sidebarMoreFailed.set(false);
    this.conversationApi
      .list(SIDEBAR_CONVERSATIONS_PAGE_SIZE, offset)
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        catchError(() => {
          this.sidebarMoreFailed.set(true);
          return EMPTY;
        }),
        finalize(() => this.sidebarLoadingMore.set(false)),
      )
      .subscribe((rows) => {
        if (rows.length === 0) {
          this.sidebarHasMore.set(false);
          return;
        }
        this.conversations.update((prev) => {
          const seen = new Set(prev.map((c) => c.id));
          const next = [...prev];
          for (const r of rows) {
            if (!seen.has(r.id)) {
              seen.add(r.id);
              next.push(r);
            }
          }
          return next;
        });
        this.sidebarHasMore.set(
          rows.length === SIDEBAR_CONVERSATIONS_PAGE_SIZE,
        );
      });
  }

  onSidebarScroll(ev: Event): void {
    const el = ev.target as HTMLElement;
    if (
      !this.sidebarHasMore() ||
      this.sidebarLoadingMore() ||
      this.sidebarListLoading() ||
      this.sidebarListError()
    ) {
      return;
    }
    const nearBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight <=
      SIDEBAR_LOAD_MORE_NEAR_BOTTOM_PX;
    if (nearBottom) {
      this.loadMoreSidebarConversations();
    }
  }

  selectConversation(id: string): void {
    // Before the same-id early return below: on a phone, tapping the chat you
    // are already in must still take you back to it.
    this.historyOpen.set(false);
    this.cancelRename();
    this.revokeBlobPreviews(this.attachedFiles());
    this.attachedFiles.set([]);
    if (this.conversationId() === id) {
      return;
    }
    this.threadPinBottomActive = false;
    this.teardownThreadLayoutPin();
    this.cancelOutbound$.next();
    this.chunkBatcher.cancelPending();
    this.showJumpToBottom.set(false);
    this.threadLoadSeq++;
    const loadId = this.threadLoadSeq;
    this.bubbles.set([]);
    this.threadHasMoreOlder.set(false);
    this.threadOldestMessageId.set(null);
    this.threadOlderLoading.set(false);
    this.threadOlderLoadFailed.set(false);
    this.historyThreadLoading.set(true);
    this.historyThreadError.set(false);
    this.conversationId.set(id);
    this.syncConversationParam(id);
    this.conversationApi
      .listMessages(id, { limit: THREAD_MESSAGE_PAGE_SIZE })
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        catchError(() => {
          if (loadId === this.threadLoadSeq) {
            this.historyThreadError.set(true);
            this.bubbles.set([]);
          }
          return of({
            messages: [],
            has_more: false,
          } satisfies HistoryMessagesPageDto);
        }),
        finalize(() => {
          if (loadId === this.threadLoadSeq) {
            this.historyThreadLoading.set(false);
          }
        }),
      )
      .subscribe((page) => {
        if (loadId !== this.threadLoadSeq) {
          return;
        }
        const bubbles = this.mapHistoryMessagesToBubbles(page.messages);
        this.bubbles.set(bubbles);
        this.threadHasMoreOlder.set(page.has_more);
        this.threadOldestMessageId.set(bubbles.length ? bubbles[0].id : null);
        this.reattachActiveJob(id, loadId);
        this.scrollThreadToEnd();
        this.setupThreadLayoutPinAfterOpen(loadId);
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (loadId !== this.threadLoadSeq || !this.threadPinBottomActive) {
              return;
            }
            this.scrollThreadToEnd();
          });
        });
      });
  }

  /**
   * Re-attaches to a generation that kept running while the user was away.
   *
   * Jobs are detached from the request that started them, so revisiting a thread
   * would otherwise show nothing until the worker finished. Replaying the Redis
   * Stream from entry 0 rebuilds the text produced so far, then live chunks continue.
   */
  private reattachActiveJob(conversationId: string, loadId: number): void {
    this.conversationApi
      .activeJob(conversationId)
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        takeUntil(this.cancelOutbound$),
        // A thread with no running job is the normal case; never surface an error.
        catchError(() => of(null)),
      )
      .subscribe((job) => {
        // No stream_token means the gateway did not intercept the route — opening the
        // stream would only earn a 401, so stay quiet rather than fake a live bubble.
        if (
          !job?.stream_token ||
          loadId !== this.threadLoadSeq ||
          this.busy()
        ) {
          return;
        }

        const assistantId = crypto.randomUUID();
        this.bubbles.update((list) => [
          ...list,
          { id: assistantId, role: "assistant", text: "" },
        ]);
        this.busy.set(true);
        this.pendingStage.set(
          job.status === "processing" ? "thinking" : "queued",
        );
        this.pendingTick.set(0);
        this.retryProgress.set(null);

        this.messageStream
          .openStream(job.job_id, job.stream_token)
          .pipe(
            takeUntilDestroyed(this.destroyRef),
            takeUntil(this.cancelOutbound$),
            tap((ev) => this.applyStreamEvent(ev, assistantId)),
            catchError(() => {
              // Buffered chunks may not have painted yet; they still count as text.
              this.chunkBatcher.flushNow();
              // Drop the placeholder only while it is still empty (job finished or
              // its stream expired before the first chunk). Once text has been
              // replayed, keep it — a dropped connection must not wipe what the
              // user can already read.
              if (!this.assistantText(assistantId)) {
                this.removeBubble(assistantId);
              }
              return EMPTY;
            }),
            finalize(() => this.busy.set(false)),
          )
          .subscribe();
      });
  }

  private removeBubble(bubbleId: string): void {
    this.bubbles.update((list) => list.filter((b) => b.id !== bubbleId));
  }

  /** Jumps back to the newest message and resumes following the stream. */
  jumpToBottom(): void {
    this.showJumpToBottom.set(false);
    this.threadPinBottomActive = true;
    this.scrollThreadToEnd();
  }

  /** Loads older messages when the user scrolls near the top of the thread. */
  onThreadScroll(ev: Event): void {
    const el = ev.target as HTMLElement;
    this.showJumpToBottom.set(
      el.scrollHeight - el.scrollTop - el.clientHeight >
        THREAD_JUMP_TO_BOTTOM_GAP_PX,
    );
    if (this.threadPinBottomActive) {
      const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (gap > THREAD_PIN_BOTTOM_RELEASE_GAP_PX) {
        this.threadPinBottomActive = false;
        this.teardownThreadLayoutPin();
      }
    }
    if (
      el.scrollTop > THREAD_LOAD_OLDER_SCROLL_TOP_PX ||
      !this.threadHasMoreOlder() ||
      this.threadOlderLoading() ||
      this.historyThreadLoading() ||
      this.historyThreadError()
    ) {
      return;
    }
    this.tryLoadOlderMessages();
  }

  private tryLoadOlderMessages(): void {
    const cid = this.conversationId();
    const oldest = this.threadOldestMessageId();
    if (
      !cid ||
      oldest === null ||
      !this.threadHasMoreOlder() ||
      this.threadOlderLoading() ||
      this.historyThreadLoading() ||
      this.historyThreadError()
    ) {
      return;
    }

    this.threadOlderLoadFailed.set(false);
    this.threadOlderLoading.set(true);
    this.threadPinBottomActive = false;
    this.teardownThreadLayoutPin();
    const loadId = this.threadLoadSeq;
    const threadEl = this.threadRef()?.nativeElement;
    const prevScrollHeight = threadEl?.scrollHeight ?? 0;
    const prevScrollTop = threadEl?.scrollTop ?? 0;

    this.conversationApi
      .listMessages(cid, {
        limit: THREAD_MESSAGE_PAGE_SIZE,
        beforeId: oldest,
      })
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        catchError(() => {
          if (loadId === this.threadLoadSeq) {
            this.threadOlderLoadFailed.set(true);
          }
          return EMPTY;
        }),
        finalize(() => {
          if (loadId === this.threadLoadSeq) {
            this.threadOlderLoading.set(false);
          }
        }),
      )
      .subscribe((page) => {
        if (loadId !== this.threadLoadSeq) {
          return;
        }
        const older = this.mapHistoryMessagesToBubbles(page.messages);
        this.threadHasMoreOlder.set(page.has_more);
        if (!older.length) {
          return;
        }
        this.threadOldestMessageId.set(older[0].id);
        this.bubbles.update((prev) => [...older, ...prev]);
        requestAnimationFrame(() => {
          const el = this.threadRef()?.nativeElement;
          if (el) {
            el.scrollTop = prevScrollTop + (el.scrollHeight - prevScrollHeight);
          }
        });
      });
  }

  /** Manual retry after older-message pagination fails (banner action). */
  retryLoadOlderThread(): void {
    if (
      !this.threadOlderLoadFailed() ||
      this.threadOlderLoading() ||
      !this.threadHasMoreOlder() ||
      this.historyThreadLoading() ||
      this.historyThreadError()
    ) {
      return;
    }
    this.tryLoadOlderMessages();
  }

  private mapHistoryMessagesToBubbles(
    msgs: readonly HistoryMessageDto[],
  ): ChatBubble[] {
    return msgs.map((m) => ({
      id: m.id,
      role:
        m.role === "user"
          ? "user"
          : m.generation_error_code
            ? "error"
            : m.role === "assistant"
              ? "assistant"
              : "assistant",
      text: m.generation_error_code
        ? m.generation_error_summary?.trim() || m.content
        : m.content,
      retryable: !!m.generation_error_code,
      attachments:
        m.role === "user" && m.files?.length
          ? m.files.map((f) => ({
              file_id: f.file_id,
              name: f.name,
              mime_type: f.mime_type ?? undefined,
            }))
          : undefined,
    }));
  }

  beginRename(ev: Event, c: ConversationSummaryDto): void {
    ev.stopPropagation();
    ev.preventDefault();
    this.renameFailed.set(false);
    this.renamingConversationId.set(c.id);
    this.renameBuffer = (c.title ?? "").trim();
  }

  cancelRename(): void {
    this.renamingConversationId.set(null);
    this.renameBuffer = "";
    this.renameFailed.set(false);
    this.renameSaving.set(false);
  }

  requestDeleteConversation(ev: Event, id: string): void {
    ev.stopPropagation();
    ev.preventDefault();
    this.cancelRename();
    const ref = this.dialogService.open(ConfirmationDialogComponent, {
      header: this.translate.instant("CHAT.DELETE_TITLE"),
      data: {
        message: this.translate.instant("CHAT.DELETE_CONFIRM"),
      } satisfies ConfirmDialogModel,
      modal: true,
      closable: !this.deletingConversation(),
    });
    if (!ref) {
      return;
    }
    ref.onClose
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((confirmed: boolean) => {
        if (confirmed) {
          this.executeDelete(id);
        }
      });
  }

  private executeDelete(id: string): void {
    if (this.deletingConversation()) {
      return;
    }
    this.deletingConversation.set(true);
    this.conversationApi
      .delete(id)
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        catchError(() => EMPTY),
        finalize(() => this.deletingConversation.set(false)),
      )
      .subscribe(() => {
        this.conversations.update((list) => list.filter((c) => c.id !== id));
        if (this.conversationId() === id) {
          this.newChat();
        }
      });
  }

  onRenameKeydown(ev: KeyboardEvent): void {
    if (ev.key === "Escape") {
      ev.preventDefault();
      this.cancelRename();
      return;
    }
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      this.submitRename();
    }
  }

  submitRename(): void {
    const id = this.renamingConversationId();
    if (!id || this.renameSaving()) {
      return;
    }
    const title = this.renameBuffer.trim().slice(0, 200);
    this.renameSaving.set(true);
    this.renameFailed.set(false);
    this.conversationApi
      .patchTitle(id, title)
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        catchError(() => {
          this.renameFailed.set(true);
          return EMPTY;
        }),
        finalize(() => this.renameSaving.set(false)),
      )
      .subscribe((res) => {
        this.conversations.update((list) =>
          list.map((row) =>
            row.id === res.id ? { ...row, title: res.title } : row,
          ),
        );
        this.renamingConversationId.set(null);
        this.renameBuffer = "";
        this.renameFailed.set(false);
      });
  }

  formatListTime(iso: string | null): string {
    if (!iso) {
      return "—";
    }
    const d = new Date(iso);
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(d);
  }

  openFilePicker(): void {
    if (
      this.busy() ||
      this.historyThreadLoading() ||
      this.attachedFiles().length >= MAX_CHAT_ATTACHMENTS
    ) {
      return;
    }
    this.fileInputRef()?.nativeElement.click();
  }

  onFileInputChange(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    // Snapshot before clearing `value` — resetting the input empties the live `FileList`
    // in common browsers, so `input.files` would read as empty after `input.value = ""`.
    const picked = input.files?.length ? Array.from(input.files) : [];
    input.value = "";
    if (!picked.length || this.busy() || this.historyThreadLoading()) {
      return;
    }
    const room = MAX_CHAT_ATTACHMENTS - this.attachedFiles().length;
    if (room <= 0) {
      return;
    }
    const slice = picked.slice(0, room);

    const allowed = slice.filter((f) => f.size <= MAX_CHAT_ATTACHMENT_BYTES);
    const skipped = slice.length - allowed.length;
    if (skipped > 0) {
      const maxMb = Math.floor(MAX_CHAT_ATTACHMENT_BYTES / (1024 * 1024));
      this.appendErrorBubble(
        new Error(
          this.translate.instant("CHAT.ATTACHMENT_TOO_LARGE", { maxMb }),
        ),
      );
    }
    if (!allowed.length) {
      return;
    }

    const rows: ComposerAttachmentRow[] = allowed.map((file) => ({
      client_key: crypto.randomUUID(),
      file_id: null,
      name: file.name,
      mime_type: file.type || null,
      preview_url: createImagePreviewObjectUrl(file),
      uploading: true,
    }));

    this.attachedFiles.update((prev) => [...prev, ...rows]);

    for (let i = 0; i < allowed.length; i++) {
      const file = allowed[i];
      const client_key = rows[i].client_key;
      if (attachmentKindFromMimeAndName(file.type, file.name) !== "pdf") {
        continue;
      }
      void renderPdfFirstPageDataUrl(file).then((dataUrl) => {
        if (!dataUrl) {
          return;
        }
        this.ngZone.run(() => {
          this.attachedFiles.update((list) =>
            list.map((r) =>
              r.client_key === client_key ? { ...r, preview_url: dataUrl } : r,
            ),
          );
        });
      });
    }

    this.fileUploadBusy.set(true);
    from(allowed.map((file, i) => ({ file, client_key: rows[i].client_key })))
      .pipe(
        mergeMap(
          ({ file, client_key }) =>
            this.uploadOneLocalFile(file).pipe(
              tap((payload) => {
                this.attachedFiles.update((list) =>
                  list.map((r) =>
                    r.client_key === client_key
                      ? {
                          ...r,
                          file_id: payload.file_id,
                          name: payload.name,
                          mime_type: payload.mime_type ?? null,
                          uploading: false,
                          failed: false,
                        }
                      : r,
                  ),
                );
              }),
              catchError(() => {
                const msg = this.translate.instant(
                  "CHAT.ATTACHMENT_UPLOAD_FAILED",
                );
                this.appendErrorBubble(new Error(msg));
                this.attachedFiles.update((list) =>
                  list.map((r) =>
                    r.client_key === client_key
                      ? { ...r, uploading: false, failed: true }
                      : r,
                  ),
                );
                return EMPTY;
              }),
            ),
          UPLOAD_CONCURRENCY,
        ),
        finalize(() => this.fileUploadBusy.set(false)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe();
  }

  removeAttachment(index: number): void {
    if (this.busy()) {
      return;
    }
    const row = this.attachedFiles()[index];
    if (!row || row.uploading) {
      return;
    }

    const removeLocally = (): void => {
      this.revokeBlobPreview(row.preview_url);
      this.attachedFiles.update((prev) => prev.filter((_, i) => i !== index));
    };

    if (!row.file_id || row.failed) {
      removeLocally();
      return;
    }

    this.fileApi
      .deleteFile(row.file_id)
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        catchError((err: unknown) => {
          this.appendErrorBubble(err);
          return EMPTY;
        }),
      )
      .subscribe(() => removeLocally());
  }

  attachmentShowsRasterPreview(row: ComposerAttachmentRow): boolean {
    if (!row.preview_url) {
      return false;
    }
    const kind = attachmentKindFromMimeAndName(row.mime_type, row.name);
    return kind === "image" || kind === "pdf";
  }

  attachmentKind(mime: string | null | undefined): AttachmentKind {
    return classifyAttachmentMime(mime);
  }

  attachmentIconClass(
    mime: string | null | undefined,
    fileName?: string,
  ): string {
    return attachmentIconClassForMime(mime, fileName);
  }

  openAttachmentDownload(fileId: string | undefined): void {
    if (!fileId || this.busy()) {
      return;
    }
    this.fileApi
      .getDownloadUrl(fileId)
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        catchError((err: unknown) => {
          this.appendErrorBubble(err);
          return EMPTY;
        }),
      )
      .subscribe((res) => {
        window.open(res.sasDownloadUrl, "_blank", "noopener,noreferrer");
      });
  }

  private uploadOneLocalFile(file: File) {
    return this.fileApi
      .prepare({
        name: file.name,
        mimeType: file.type || undefined,
        sizeBytes: file.size,
      })
      .pipe(
        switchMap((prep) =>
          this.fileApi
            .putBlobViaSasUrl(prep.sasUploadUrl, file, file.type || undefined)
            .pipe(switchMap(() => this.fileApi.confirm(prep.fileId))),
        ),
        map((rec) => ({
          file_id: rec.id,
          name: rec.name,
          mime_type: rec.mimeType ?? null,
        })),
      );
  }

  send(): void {
    const text = this.draft().trim();
    if (!text || this.busy() || this.fileUploadBusy()) {
      return;
    }

    const pending = this.attachedFiles();
    if (pending.some((r) => r.uploading || r.failed || r.file_id === null)) {
      return;
    }

    const filesSnapshot: MessageFileAttachPayload[] = pending.map((r) => ({
      file_id: r.file_id as string,
      name: r.name,
      mime_type: r.mime_type ?? undefined,
    }));

    this.revokeBlobPreviews(pending);
    this.attachedFiles.set([]);

    const userBubble: ChatBubble = {
      id: crypto.randomUUID(),
      role: "user",
      text,
      attachments:
        filesSnapshot.length > 0
          ? filesSnapshot.map((f) => ({
              file_id: f.file_id,
              name: f.name,
              mime_type: f.mime_type ?? undefined,
            }))
          : undefined,
    };
    this.bubbles.update((list) => [...list, userBubble]);
    this.draft.set("");
    const draftTa = this.draftArea()?.nativeElement;
    if (draftTa) {
      draftTa.style.height = "auto";
    }
    this.scrollThreadToEnd();

    this.busy.set(true);
    this.pendingStage.set("queued");
    this.pendingTick.set(0);
    this.retryProgress.set(null);
    this.messages
      .postMessage({
        text,
        conversation_id: this.conversationId(),
        model: this.selectedChatModel(),
        files: filesSnapshot,
      })
      .pipe(
        takeUntil(this.cancelOutbound$),
        switchMap((job) => {
          this.conversationId.set(job.conversation_id);
          this.syncConversationParam(job.conversation_id);
          return this.streamJobIntoNewBubble(job);
        }),
        catchError((err: unknown) => {
          this.appendErrorBubble(err);
          return EMPTY;
        }),
        finalize(() => this.busy.set(false)),
      )
      .subscribe();
  }

  /** "Try again" on a failed reply — re-runs the same user turn, no second message. */
  retryLast(): void {
    const conversationId = this.conversationId();
    const errorBubbleId = this.retryBubbleId();
    if (!conversationId || !errorBubbleId) {
      return;
    }

    // Drop the dead bubble here; the service deletes its row, so history agrees.
    // Kept aside because a rejected retry (409/404/503) deletes nothing server-side —
    // putting it back keeps "Try again" available instead of stranding the turn.
    const removed = this.bubbles().find((b) => b.id === errorBubbleId);
    const removedIndex = this.bubbles().findIndex(
      (b) => b.id === errorBubbleId,
    );
    this.bubbles.update((list) => list.filter((b) => b.id !== errorBubbleId));
    this.busy.set(true);
    this.pendingStage.set("queued");
    this.pendingTick.set(0);
    this.retryProgress.set(null);
    this.scrollThreadToEnd();

    let jobStarted = false;
    this.conversationApi
      .retryLast(conversationId, this.selectedChatModel())
      .pipe(
        takeUntil(this.cancelOutbound$),
        switchMap((job) => {
          jobStarted = true;
          return this.streamJobIntoNewBubble(job);
        }),
        catchError((err: unknown) => {
          if (jobStarted) {
            // The retry ran; this is a stream failure, reported like any other.
            this.appendErrorBubble(err);
            return EMPTY;
          }
          // retry-last itself was rejected (409/404/503) — nothing was deleted server
          // side, so put the failed reply back rather than stacking a second bubble
          // that would hide its "Try again". The global HTTP dialog states the reason.
          this.restoreRetryableBubble(removed, removedIndex);
          return EMPTY;
        }),
        finalize(() => this.busy.set(false)),
      )
      .subscribe();
  }

  /** Puts a failed reply back where it was after a rejected retry. */
  private restoreRetryableBubble(
    bubble: ChatBubble | undefined,
    index: number,
  ): void {
    if (!bubble || index < 0) {
      return;
    }
    this.bubbles.update((list) => {
      if (list.some((b) => b.id === bubble.id)) {
        return list;
      }
      const next = [...list];
      next.splice(Math.min(index, next.length), 0, bubble);
      return next;
    });
  }

  /** Adds the streaming placeholder and pipes the job's SSE events into it. */
  private streamJobIntoNewBubble(
    job: MessageJobResponse,
  ): Observable<MessageStreamEvent> {
    const assistantId = crypto.randomUUID();
    this.bubbles.update((list) => [
      ...list,
      { id: assistantId, role: "assistant", text: "" },
    ]);
    this.scrollThreadToEnd();
    return this.messageStream.openStream(job.job_id, job.stream_token).pipe(
      takeUntil(this.cancelOutbound$),
      tap((ev) => this.applyStreamEvent(ev, assistantId)),
    );
  }

  private applyStreamEvent(ev: MessageStreamEvent, assistantId: string): void {
    if (ev.type === "claimed") {
      // Worker acknowledgment — advance the pending label to the thinking stage.
      this.pendingStage.set("thinking");
      return;
    }

    if (ev.type === "retrying") {
      // Retryable provider error before the first chunk — the job is still alive,
      // so say so instead of leaving a frozen bubble.
      this.retryProgress.set({ attempt: ev.attempt, max: ev.max_attempts });
      this.pendingStage.set("retrying");
      return;
    }

    if (ev.type === "chunk") {
      // Painted on the next frame — a replay or a burst becomes one update, not dozens.
      this.chunkBatcher.add(assistantId, ev.text);
      return;
    }

    if (ev.type === "done") {
      // Apply anything still buffered before reading the bubble as a full_text fallback.
      this.chunkBatcher.flushNow();
      this.mergeConversationTitleFromStreamDone(ev);
      const serverId = ev.assistant_message_id.trim();
      const finalText =
        ev.full_text.trim() ||
        this.assistantText(assistantId).trim() ||
        "No text in response.";
      this.bubbles.update((list) => {
        const i = list.findIndex((b) => b.id === assistantId);
        if (i < 0) {
          return list;
        }
        const row = list[i];
        if (row.role !== "assistant") {
          return list;
        }
        // On re-attach the answer may already be in loaded history — keep that row
        // and drop the placeholder rather than creating a second bubble.
        if (serverId && list.some((b, idx) => idx !== i && b.id === serverId)) {
          return list.filter((_, idx) => idx !== i);
        }
        const next = [...list];
        next[i] = { ...row, id: serverId, text: finalText };
        return next;
      });
      this.scrollThreadToEnd();
      this.refreshConversationList();
      return;
    }

    if (ev.type === "error") {
      this.chunkBatcher.cancelPending();
      const msg =
        ev.error_summary?.trim() || ev.detail?.trim() || "Stream error";
      const bubbleId = ev.assistant_message_id?.trim() || assistantId;
      this.bubbles.update((list) => {
        const i = list.findIndex((b) => b.id === assistantId);
        if (i < 0) {
          return [
            ...list,
            {
              id: bubbleId,
              role: "error" as const,
              text: msg,
              retryable: true,
            },
          ];
        }
        const next = [...list];
        next[i] = {
          id: bubbleId,
          role: "error" as const,
          text: msg,
          retryable: true,
        };
        return next;
      });
      this.scrollThreadToEnd();
      return;
    }
  }

  private mergeConversationTitleFromStreamDone(
    ev: MessageStreamDoneEvent,
  ): void {
    const cid = ev.conversation_id?.trim();
    const title = ev.conversation_title?.trim();
    if (!cid || !title) {
      return;
    }
    this.conversations.update((list) => {
      const idx = list.findIndex((c) => c.id === cid);
      if (idx < 0) {
        return list;
      }
      const next = [...list];
      next[idx] = { ...list[idx], title };
      return next;
    });
  }

  /** Appends one frame's worth of buffered chunks in a single state update. */
  private applyBatchedChunks(batched: ReadonlyMap<string, string>): void {
    this.bubbles.update((list) => {
      let next: ChatBubble[] | null = null;
      for (const [bubbleId, text] of batched) {
        const i = (next ?? list).findIndex((b) => b.id === bubbleId);
        if (i < 0) {
          continue;
        }
        const row = (next ?? list)[i];
        if (row.role !== "assistant") {
          continue;
        }
        next ??= [...list];
        next[i] = { ...row, text: row.text + text };
      }
      return next ?? list;
    });
    this.scrollThreadToEnd();
  }

  private assistantText(assistantId: string): string {
    const list = this.bubbles();
    const row = list.find((b) => b.id === assistantId);
    return row?.role === "assistant" ? row.text : "";
  }

  protected appendErrorBubble(err: unknown): void {
    let msg = "Request failed";
    if (err instanceof TimeoutError) {
      msg = "The assistant took too long to respond. Please try again.";
    } else if (err instanceof HttpErrorResponse) {
      const body = err.error;
      if (typeof body === "object" && body !== null && "detail" in body) {
        const d = (body as { detail: unknown }).detail;
        msg = typeof d === "string" ? d : err.message || msg;
      } else {
        msg = err.message || msg;
      }
    } else if (err instanceof Error) {
      msg = err.message;
    }
    this.bubbles.update((list) => [
      ...list,
      { id: crypto.randomUUID(), role: "error" as const, text: msg },
    ]);
    this.scrollThreadToEnd();
  }

  private revokeBlobPreview(url: string | null | undefined): void {
    if (url?.startsWith("blob:")) {
      URL.revokeObjectURL(url);
    }
  }

  private revokeBlobPreviews(rows: readonly ComposerAttachmentRow[]): void {
    for (const r of rows) {
      this.revokeBlobPreview(r.preview_url);
    }
  }

  private teardownThreadLayoutPin(): void {
    this.threadLayoutPinObserver?.disconnect();
    this.threadLayoutPinObserver = null;
    if (this.layoutPinScrollRaf) {
      cancelAnimationFrame(this.layoutPinScrollRaf);
      this.layoutPinScrollRaf = 0;
    }
  }

  private scheduleLayoutPinScroll(): void {
    if (!this.threadPinBottomActive || this.layoutPinScrollRaf) {
      return;
    }
    this.layoutPinScrollRaf = requestAnimationFrame(() => {
      this.layoutPinScrollRaf = 0;
      if (!this.threadPinBottomActive) {
        return;
      }
      this.scrollThreadToEnd();
    });
  }

  /** Clamp scroll to bottom while the thread layout changes (e.g. attachment previews/errors). */
  private setupThreadLayoutPinAfterOpen(forLoadSeq: number): void {
    this.teardownThreadLayoutPin();
    this.threadPinBottomActive = true;
    afterNextRender(
      () => {
        if (!this.threadPinBottomActive || forLoadSeq !== this.threadLoadSeq) {
          return;
        }
        const growRoot = this.threadScrollContentRef()?.nativeElement;
        if (!growRoot) {
          return;
        }

        /*
         * Growth is a resize, and only a resize.
         *
         * There used to be a second observer here — an IntersectionObserver on
         * a bottom sentinel that re-pinned whenever the sentinel left the
         * viewport by 48px. But a sentinel leaving the viewport is *also*
         * exactly what the user scrolling up looks like, and the observer
         * could not tell the two apart. Since the release below needs a 120px
         * gap, every drag that landed in the 48-120px band was dragged back to
         * the bottom before it could release: measured on 2026-09-21 as
         * `wheel -60: gap 100 -> 0`, and reported as the thread refusing to
         * scroll up until you flicked hard enough.
         *
         * The ResizeObserver already covers every case the intersection one
         * was for — streaming tokens, an image loading, an attachment preview
         * appearing all resize this element — so the second mechanism was a
         * duplicate reporting the same event plus one false positive.
         */
        this.threadLayoutPinObserver = new ResizeObserver(() => {
          this.scheduleLayoutPinScroll();
        });
        this.threadLayoutPinObserver.observe(growRoot);

        this.scheduleLayoutPinScroll();
      },
      { injector: this.injector },
    );
  }

  private scrollThreadToEnd(): void {
    // Coalesced: repeated calls in one frame force a single layout, not one each.
    if (this.scrollToEndRaf !== 0) {
      return;
    }
    this.scrollToEndRaf = requestAnimationFrame(() => {
      this.scrollToEndRaf = 0;
      const el = this.threadRef()?.nativeElement;
      if (el) {
        const prevBehavior = el.style.scrollBehavior;
        el.style.scrollBehavior = "auto";
        el.scrollTop = el.scrollHeight;
        el.style.scrollBehavior = prevBehavior;
      }
    });
  }
}
