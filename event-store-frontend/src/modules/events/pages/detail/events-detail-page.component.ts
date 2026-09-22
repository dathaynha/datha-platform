import { DatePipe } from "@angular/common";
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
import type { PlatformEvent } from "@models/event.model";
import { TranslateModule } from "@ngx-translate/core";
import { EventsService } from "@services/implementations/events.service";
import { ButtonModule } from "primeng/button";
import { TooltipModule } from "primeng/tooltip";
import { EMPTY, finalize, switchMap } from "rxjs";
import { catchError } from "rxjs/operators";

@Component({
  selector: "app-events-detail-page",
  imports: [DatePipe, TranslateModule, ButtonModule, TooltipModule],
  templateUrl: "./events-detail-page.component.html",
  styleUrls: ["./events-detail-page.component.scss"],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: "flex h-full min-h-0 min-w-0 w-full flex-1 flex-col overflow-hidden",
  },
})
export class EventsDetailPageComponent implements OnInit {
  private readonly eventsService = inject(EventsService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  readonly locale = inject(LOCALE_ID);

  readonly loading = signal(true);
  readonly loadError = signal(false);
  readonly record = signal<PlatformEvent | null>(null);

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
          this.record.set(null);
          return this.eventsService.getById(id).pipe(
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
}
