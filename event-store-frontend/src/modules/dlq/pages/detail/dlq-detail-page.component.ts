import { DatePipe } from "@angular/common";
import { HttpErrorResponse } from "@angular/common/http";
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  LOCALE_ID,
  OnInit,
  signal,
} from "@angular/core";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { ActivatedRoute, Router } from "@angular/router";
import type { ConfirmDialogModel } from "@models/dialog.model";
import type { DlqRecord } from "@models/dlq.model";
import { ConfirmationDialogComponent } from "@datha/platform-ui";
import { TranslateModule, TranslateService } from "@ngx-translate/core";
import { DlqService } from "@services/implementations/dlq.service";
import { ButtonModule } from "primeng/button";
import { TagModule } from "primeng/tag";
import { TooltipModule } from "primeng/tooltip";
import { DialogService } from "primeng/dynamicdialog";
import { EMPTY, finalize, switchMap } from "rxjs";
import { catchError } from "rxjs/operators";

@Component({
  selector: "app-dlq-detail-page",
  imports: [DatePipe, TranslateModule, ButtonModule, TagModule, TooltipModule],
  templateUrl: "./dlq-detail-page.component.html",
  styleUrls: ["./dlq-detail-page.component.scss"],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: "flex h-full min-h-0 min-w-0 w-full flex-1 flex-col overflow-hidden",
  },
})
export class DlqDetailPageComponent implements OnInit {
  private readonly dlq = inject(DlqService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly dialog = inject(DialogService);
  private readonly translate = inject(TranslateService);
  readonly locale = inject(LOCALE_ID);

  readonly loading = signal(true);
  readonly loadError = signal(false);
  readonly record = signal<DlqRecord | null>(null);
  readonly replaying = signal(false);
  readonly replayError = signal<string | null>(null);
  readonly replaySuccess = signal(false);

  ngOnInit(): void {
    this.route.paramMap
      .pipe(
        switchMap((params) => {
          const id = params.get("id");
          if (!id) {
            this.loadError.set(true);
            this.loading.set(false);
            return EMPTY;
          }
          this.loading.set(true);
          this.loadError.set(false);
          this.replayError.set(null);
          this.replaySuccess.set(false);
          this.record.set(null);
          return this.dlq.getById(id).pipe(
            finalize(() => this.loading.set(false)),
            catchError(() => {
              this.loadError.set(true);
              return EMPTY;
            }),
          );
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((detail) => this.record.set(detail));
  }

  goBack(): void {
    void this.router.navigate([".."], { relativeTo: this.route });
  }

  requestReplay(): void {
    const detail = this.record();
    if (!detail || !this.canReplay(detail)) {
      return;
    }

    const ref = this.dialog.open(ConfirmationDialogComponent, {
      header: this.translate.instant("DLQ_PAGE.REPLAY.CONFIRM_TITLE"),
      data: {
        message: this.translate.instant("DLQ_PAGE.REPLAY.CONFIRM_MESSAGE", {
          subject: detail.originalSubject,
        }),
      } satisfies ConfirmDialogModel,
      width: "min(520px, 92vw)",
      modal: true,
      closable: true,
      duplicate: true,
    });
    if (!ref) {
      return;
    }

    ref.onClose
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((confirmed: boolean) => {
        if (confirmed) {
          this.executeReplay(detail.id);
        }
      });
  }

  copyText(value: string): void {
    void navigator.clipboard?.writeText(value);
  }

  formatJson(value: unknown): string {
    if (value == null) {
      return "—";
    }
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  isReplayed(record: DlqRecord): boolean {
    return record.replayedAt != null;
  }

  canReplay(record: DlqRecord): boolean {
    return !this.isReplayed(record) && this.hasEnvelope(record);
  }

  hasEnvelope(record: DlqRecord): boolean {
    return (
      record.envelope != null &&
      typeof record.envelope === "object" &&
      !Array.isArray(record.envelope)
    );
  }

  private executeReplay(id: string): void {
    if (this.replaying()) {
      return;
    }

    this.replaying.set(true);
    this.replayError.set(null);
    this.replaySuccess.set(false);

    this.dlq
      .replay(id)
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        catchError((err: unknown) => {
          this.replayError.set(this.replayErrorMessage(err));
          return EMPTY;
        }),
        finalize(() => this.replaying.set(false)),
      )
      .subscribe((result) => {
        if (!result) {
          return;
        }
        this.replaySuccess.set(true);
        this.record.update((current) =>
          current?.id === id
            ? { ...current, replayedAt: result.replayedAt }
            : current,
        );
      });
  }

  private replayErrorMessage(err: unknown): string {
    if (!(err instanceof HttpErrorResponse)) {
      return this.translate.instant("DLQ_PAGE.REPLAY.ERROR_GENERIC");
    }
    const body = err.error as { error?: string } | null;
    if (body?.error) {
      return body.error;
    }
    if (err.status === 409) {
      return this.translate.instant("DLQ_PAGE.REPLAY.ERROR_ALREADY_REPLAYED");
    }
    if (err.status === 400) {
      return this.translate.instant("DLQ_PAGE.REPLAY.ERROR_NO_ENVELOPE");
    }
    if (err.status === 404) {
      return this.translate.instant("DLQ_PAGE.REPLAY.ERROR_NOT_FOUND");
    }
    return this.translate.instant("DLQ_PAGE.REPLAY.ERROR_GENERIC");
  }
}
