import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  input,
  NgZone,
  signal,
} from "@angular/core";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { FILE_SERVICE_INJECTOR } from "@constants/injection-token.constant";
import { TranslateModule } from "@ngx-translate/core";
import { catchError, EMPTY, take } from "rxjs";

import {
  attachmentIconClass,
  attachmentKindFromMimeAndName,
} from "./attachment-meta";
import { renderPdfFirstPageDataUrlFromArrayBuffer } from "./attachment-preview";

@Component({
  selector: "app-chat-thread-attachment",
  standalone: true,
  imports: [TranslateModule],
  template: `
    <button
      type="button"
      class="flex w-[7.25rem] shrink-0 cursor-pointer flex-col overflow-hidden rounded-xl border border-white/[0.18] bg-gradient-to-b from-white/[0.14] to-white/[0.04] text-left shadow-[inset_0_1px_0_rgba(255,255,255,0.12)] outline-none transition hover:border-white/25 hover:from-white/[0.18] focus-visible:ring-2 focus-visible:ring-white/30 disabled:cursor-not-allowed disabled:opacity-45"
      [disabled]="disabled() || !fileId()"
      [attr.aria-label]="
        ('CHAT.OPEN_FILE_ATTACHMENT' | translate) + ': ' + attachmentName()
      "
      (click)="onOpen($event)"
    >
      <div
        class="relative flex h-[4.25rem] items-center justify-center overflow-hidden bg-black/20"
      >
        @if (showsThumb()) {
          <img
            [src]="previewUrl()!"
            alt=""
            class="pointer-events-none h-full w-full object-cover"
          />
        } @else {
          <span
            class="pointer-events-none absolute inset-0 opacity-[0.14]"
            style="
              background: radial-gradient(
                ellipse at 50% 35%,
                rgba(255, 255, 255, 0.55),
                transparent 62%
              );
            "
            aria-hidden="true"
          ></span>
          <span
            class="relative text-2xl opacity-[0.72]"
            [class]="attachmentIconClass(mimeType(), attachmentName())"
            aria-hidden="true"
          ></span>
        }
        @if (previewBusy()) {
          <span
            class="absolute inset-0 flex items-center justify-center bg-black/40 backdrop-blur-[1px]"
            aria-hidden="true"
          >
            <span
              class="pi pi-spinner animate-spin text-lg text-white/90"
            ></span>
          </span>
        }
      </div>
      <span
        class="truncate px-2 py-1.5 text-[0.65rem] font-medium leading-tight text-white/90"
        [title]="attachmentName()"
      >
        {{ attachmentName() }}
      </span>
      @if (loadUnavailable()) {
        <span
          class="block px-2 pb-1.5 pt-0 text-[0.58rem] leading-tight text-amber-200/95"
          role="status"
        >
          {{ "CHAT.ATTACHMENT_UNAVAILABLE" | translate }}
        </span>
      }
    </button>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChatThreadAttachmentComponent implements AfterViewInit {
  readonly fileId = input.required<string>();
  readonly attachmentName = input.required<string>();
  readonly mimeType = input<string | null>(null);
  readonly disabled = input(false);

  private readonly fileApi = inject(FILE_SERVICE_INJECTOR);
  private readonly destroyRef = inject(DestroyRef);
  private readonly ngZone = inject(NgZone);

  readonly previewUrl = signal<string | null>(null);
  readonly previewBusy = signal(false);
  /** Preview or open-in-tab failed (e.g. missing file); shown inline — never scroll-jumps the thread. */
  readonly loadUnavailable = signal(false);

  protected readonly attachmentIconClass = attachmentIconClass;

  /** Must be a `computed` so OnPush re-renders when preview signals update (method calls don’t subscribe PDF thumb reliably). */
  readonly showsThumb = computed(() => {
    const u = this.previewUrl();
    if (!u) {
      return false;
    }
    if (u.startsWith("data:image/")) {
      return true;
    }
    const k = attachmentKindFromMimeAndName(
      this.mimeType(),
      this.attachmentName(),
    );
    return k === "image" || k === "pdf";
  });

  private sasHref: string | null = null;

  ngAfterViewInit(): void {
    queueMicrotask(() => this.startRasterPreviewLoad());
  }

  onOpen(ev: Event): void {
    ev.preventDefault();
    ev.stopPropagation();
    if (this.disabled() || !this.fileId()) {
      return;
    }
    if (this.sasHref) {
      window.open(this.sasHref, "_blank", "noopener,noreferrer");
      return;
    }
    this.fileApi
      .getDownloadUrl(this.fileId())
      .pipe(
        take(1),
        catchError((_err: unknown) => {
          this.ngZone.run(() => this.loadUnavailable.set(true));
          return EMPTY;
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((res) => {
        this.sasHref = res.sasDownloadUrl;
        window.open(res.sasDownloadUrl, "_blank", "noopener,noreferrer");
      });
  }

  private startRasterPreviewLoad(): void {
    const kind = attachmentKindFromMimeAndName(
      this.mimeType(),
      this.attachmentName(),
    );
    if (kind === "image") {
      this.loadImagePreviewViaSas();
      return;
    }
    if (kind === "pdf") {
      this.loadPdfThumbViaGateway();
      return;
    }
  }

  private loadImagePreviewViaSas(): void {
    this.fileApi
      .getDownloadUrl(this.fileId())
      .pipe(
        take(1),
        catchError((_err: unknown) => {
          this.ngZone.run(() => this.loadUnavailable.set(true));
          return EMPTY;
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((res) => {
        this.sasHref = res.sasDownloadUrl;
        this.ngZone.run(() => this.previewUrl.set(res.sasDownloadUrl));
      });
  }

  private loadPdfThumbViaGateway(): void {
    const fid = this.fileId();
    this.ngZone.run(() => this.previewBusy.set(true));
    this.fileApi
      .getFileContent(fid)
      .pipe(
        take(1),
        catchError((_err: unknown) => {
          this.ngZone.run(() => {
            this.previewBusy.set(false);
            this.loadUnavailable.set(true);
          });
          return EMPTY;
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(async (buf) => {
        try {
          const dataUrl = await renderPdfFirstPageDataUrlFromArrayBuffer(buf);
          this.ngZone.run(() => {
            this.previewBusy.set(false);
            if (dataUrl) {
              this.previewUrl.set(dataUrl);
            } else {
              this.loadUnavailable.set(true);
            }
          });
        } catch {
          this.ngZone.run(() => {
            this.previewBusy.set(false);
            this.loadUnavailable.set(true);
          });
        }
      });
  }
}
