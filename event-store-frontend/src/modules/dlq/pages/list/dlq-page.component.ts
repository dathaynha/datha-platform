import { DatePipe } from "@angular/common";
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  LOCALE_ID,
  OnInit,
  signal,
} from "@angular/core";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { FormsModule } from "@angular/forms";
import { ActivatedRoute, Router } from "@angular/router";
import { DLQ_PAGE_SIZE, DLQ_PAGE_SIZE_OPTIONS } from "@constants/dlq.constant";
import {
  dlqListHasAdvancedFilters,
  parseDlqListQuery,
  toDlqListQueryParams,
} from "@helper/dlq-list-query";
import type { ListFilterChip, ListSortOrder } from "@helper/list-query-params";
import {
  listSortOrderToPrime,
  primeSortOrderToList,
  sortFilterValues,
} from "@helper/list-query-params";
import type { DlqRecord } from "@models/dlq.model";
import { TranslateModule } from "@ngx-translate/core";
import type { SortEvent } from "primeng/api";
import {
  OpsPaginatorComponent,
  type OpsPageChange,
} from "@modules/shared/ops-paginator/ops-paginator.component";
import { TableEmptyStateComponent } from "@modules/shared/table-empty-state/table-empty-state.component";
import { DlqService } from "@services/implementations/dlq.service";
import { ButtonModule } from "primeng/button";
import { InputTextModule } from "primeng/inputtext";
import { MultiSelectModule } from "primeng/multiselect";
import { DatePickerModule } from "primeng/datepicker";
import { TableModule } from "primeng/table";
import { TagModule } from "primeng/tag";
import { catchError, EMPTY, finalize, Subject, switchMap, tap } from "rxjs";

@Component({
  selector: "app-dlq-page",
  imports: [
    DatePipe,
    FormsModule,
    TranslateModule,
    ButtonModule,
    InputTextModule,
    MultiSelectModule,
    DatePickerModule,
    TableModule,
    OpsPaginatorComponent,
    TagModule,
    TableEmptyStateComponent,
  ],
  templateUrl: "./dlq-page.component.html",
  styleUrls: ["./dlq-page.theme.scss", "./dlq-page.component.scss"],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: "flex h-full min-h-0 min-w-0 w-full flex-1 flex-col overflow-hidden",
  },
})
export class DlqPageComponent implements OnInit {
  private readonly dlq = inject(DlqService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly loadListTrigger$ = new Subject<void>();
  readonly locale = inject(LOCALE_ID);

  readonly pageSize = signal<number>(DLQ_PAGE_SIZE);
  readonly pageSizeOptions = DLQ_PAGE_SIZE_OPTIONS;
  readonly sinkOptions = signal<string[]>([]);

  readonly sinksFilter = signal<string[]>([]);
  readonly correlationIdFilter = signal("");
  readonly ownerIdFilter = signal("");
  readonly fromFilter = signal<Date | null>(null);
  readonly toFilter = signal<Date | null>(null);
  readonly listOrder = signal<ListSortOrder>("desc");

  readonly rows = signal<DlqRecord[]>([]);
  readonly total = signal(0);
  /** The service stopped counting at its cap, so `total` is a floor. */
  readonly totalCapped = signal(false);
  readonly offset = signal(0);
  readonly loading = signal(false);
  readonly listError = signal(false);

  readonly pageFrom = computed(() =>
    this.total() === 0 ? 0 : this.offset() + 1,
  );
  readonly pageTo = computed(() =>
    Math.min(this.offset() + this.pageSize(), this.total()),
  );
  /** "Showing 1–50 of 715" or "… of 10,000+" when the count hit the ceiling. */
  readonly rangeKey = computed(() =>
    this.totalCapped()
      ? "DLQ_PAGE.PAGINATION.RANGE_CAPPED"
      : "DLQ_PAGE.PAGINATION.RANGE",
  );
  readonly advancedFiltersOpen = signal(false);
  readonly activeFilters = computed(() => this.buildActiveFilters());
  readonly hasActiveFilters = computed(() => this.activeFilters().length > 0);
  readonly emptyTitleKey = computed(() =>
    this.hasActiveFilters()
      ? "DLQ_PAGE.EMPTY_FILTERED"
      : "DLQ_PAGE.EMPTY_UNFILTERED",
  );
  readonly emptyHintKey = computed(() =>
    this.hasActiveFilters()
      ? "DLQ_PAGE.EMPTY_HINT_FILTERED"
      : "DLQ_PAGE.EMPTY_HINT_UNFILTERED",
  );
  readonly emptyIcon = computed(() =>
    this.hasActiveFilters() ? "pi-search" : "pi-inbox",
  );
  readonly tableStyleClass = computed(() => {
    const base = "es-table es-table--scroll";
    return this.rows().length === 0 && !this.loading()
      ? `${base} es-table--empty`
      : base;
  });
  readonly showEmptyOverlay = computed(
    () => !this.loading() && !this.listError() && this.rows().length === 0,
  );
  readonly tableSortOrder = computed(() =>
    listSortOrderToPrime(this.listOrder()),
  );

  get datePickerFormat(): string {
    return this.locale.startsWith("de") ? "dd.mm.yy" : "m/d/yy";
  }

  readonly datepickerPanelStyle = { zoom: "0.86" };

  ngOnInit(): void {
    this.loadSinkOptions();

    this.loadListTrigger$
      .pipe(
        tap(() => {
          this.loading.set(true);
          this.listError.set(false);
        }),
        switchMap(() =>
          this.dlq
            .list({
              sinks: this.sinksFilter().length
                ? [...this.sinksFilter()]
                : undefined,
              correlationId: this.correlationIdFilter().trim() || undefined,
              ownerId: this.ownerIdFilter().trim() || undefined,
              from: this.toIsoFromFilter(this.fromFilter()),
              to: this.toIsoFromFilter(this.toFilter()),
              limit: this.pageSize(),
              offset: this.offset(),
              order: this.listOrder(),
            })
            .pipe(
              finalize(() => this.loading.set(false)),
              catchError(() => {
                this.listError.set(true);
                return EMPTY;
              }),
            ),
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((res) => {
        this.rows.set(res.data);
        this.total.set(res.total);
        this.totalCapped.set(res.totalCapped ?? false);
      });

    this.applyQueryState(parseDlqListQuery(this.route.snapshot.queryParamMap));
    this.loadList();
  }

  loadList(): void {
    this.loadListTrigger$.next();
  }

  onSinksFilterChange(values: string[]): void {
    this.sinksFilter.set(sortFilterValues(values));
  }

  onTextFilterInput(
    target: { set: (value: string) => void },
    event: Event,
  ): void {
    target.set((event.target as HTMLInputElement).value);
  }

  onTableSort(event: SortEvent): void {
    const field = event.field ?? "failedAt";
    const nextOrder = primeSortOrderToList(event.order);
    if (field !== "failedAt" || nextOrder === this.listOrder()) {
      return;
    }
    this.listOrder.set(nextOrder);
    this.offset.set(0);
    this.syncUrl();
    this.loadList();
  }

  search(): void {
    this.sinksFilter.set(sortFilterValues(this.sinksFilter()));
    this.offset.set(0);
    this.syncUrl();
    this.loadList();
  }

  clearFilters(): void {
    this.sinksFilter.set([]);
    this.correlationIdFilter.set("");
    this.ownerIdFilter.set("");
    this.fromFilter.set(null);
    this.toFilter.set(null);
    this.advancedFiltersOpen.set(false);
    this.offset.set(0);
    this.syncUrl();
    this.loadList();
  }

  toggleAdvancedFilters(): void {
    this.advancedFiltersOpen.update((open) => !open);
  }

  removeActiveFilter(chipId: string): void {
    if (chipId.startsWith("sink:")) {
      const value = chipId.slice("sink:".length);
      this.sinksFilter.update((list) => list.filter((s) => s !== value));
    } else {
      switch (chipId) {
        case "correlationId":
          this.correlationIdFilter.set("");
          break;
        case "ownerId":
          this.ownerIdFilter.set("");
          break;
        case "from":
          this.fromFilter.set(null);
          break;
        case "to":
          this.toFilter.set(null);
          break;
      }
    }
    this.search();
  }

  /**
   * The paginator owns first/prev/page/next/last and the page size, so this is
   * the one entry point: take both numbers from the event rather than deriving
   * either, because changing the size also changes which record is first.
   */
  onPageChange(event: OpsPageChange): void {
    this.offset.set(event.offset);
    this.pageSize.set(event.pageSize);
    this.syncUrl();
    this.loadList();
  }

  openDetail(record: DlqRecord): void {
    void this.router.navigate([record.id], {
      relativeTo: this.route,
      queryParamsHandling: "preserve",
    });
  }

  copyText(value: string, event: Event): void {
    event.stopPropagation();
    void navigator.clipboard?.writeText(value);
  }

  truncate(value: string | null | undefined, max = 48): string {
    if (!value) {
      return "—";
    }
    if (value.length <= max) {
      return value;
    }
    return `${value.slice(0, max - 1)}…`;
  }

  isReplayed(record: DlqRecord): boolean {
    return record.replayedAt != null;
  }

  private applyQueryState(state: ReturnType<typeof parseDlqListQuery>): void {
    this.sinksFilter.set(sortFilterValues(state.sinks));
    this.correlationIdFilter.set(state.correlationId);
    this.ownerIdFilter.set(state.ownerId);
    this.fromFilter.set(state.from);
    this.toFilter.set(state.to);
    this.offset.set(state.offset);
    this.listOrder.set(state.order);
    this.advancedFiltersOpen.set(dlqListHasAdvancedFilters(state));
  }

  private currentFilterState(): ReturnType<typeof parseDlqListQuery> {
    return {
      sinks: [...this.sinksFilter()],
      correlationId: this.correlationIdFilter(),
      ownerId: this.ownerIdFilter(),
      from: this.fromFilter(),
      to: this.toFilter(),
      offset: this.offset(),
      order: this.listOrder(),
    };
  }

  private syncUrl(): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: toDlqListQueryParams(this.currentFilterState()),
      replaceUrl: true,
    });
  }

  private toIsoFromFilter(value: Date | null): string | undefined {
    if (!value || Number.isNaN(value.getTime())) {
      return undefined;
    }
    return value.toISOString();
  }

  private buildActiveFilters(): ListFilterChip[] {
    const chips: ListFilterChip[] = [];

    for (const sink of this.sinksFilter()) {
      chips.push({
        id: `sink:${sink}`,
        labelKey: "DLQ_PAGE.FILTERS.CHIP_SINK",
        labelParams: { value: sink },
      });
    }

    const correlationId = this.correlationIdFilter().trim();
    if (correlationId) {
      chips.push({
        id: "correlationId",
        labelKey: "DLQ_PAGE.FILTERS.CHIP_CORRELATION",
        labelParams: { value: correlationId },
      });
    }

    const ownerId = this.ownerIdFilter().trim();
    if (ownerId) {
      chips.push({
        id: "ownerId",
        labelKey: "DLQ_PAGE.FILTERS.CHIP_OWNER",
        labelParams: { value: ownerId },
      });
    }

    const from = this.formatFilterDate(this.fromFilter());
    if (from) {
      chips.push({
        id: "from",
        labelKey: "DLQ_PAGE.FILTERS.CHIP_FROM",
        labelParams: { value: from },
      });
    }

    const to = this.formatFilterDate(this.toFilter());
    if (to) {
      chips.push({
        id: "to",
        labelKey: "DLQ_PAGE.FILTERS.CHIP_TO",
        labelParams: { value: to },
      });
    }

    return chips;
  }

  private formatFilterDate(value: Date | null): string | null {
    if (!value || Number.isNaN(value.getTime())) {
      return null;
    }
    return value.toLocaleString(this.locale);
  }

  /**
   * The filter offers the sinks that have actually dead-lettered.
   *
   * Same failure behaviour as the events list: an empty list means no sink
   * filter, not a wrong one. The constant this replaces offered two sinks with
   * zero records and omitted the only one that had any, so every choice it
   * offered returned an empty table.
   */
  private loadSinkOptions(): void {
    this.dlq
      .listSinks()
      .pipe(
        catchError(() => EMPTY),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((sinks) => this.sinkOptions.set(sinks));
  }
}
