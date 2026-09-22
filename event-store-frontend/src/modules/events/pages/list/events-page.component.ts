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
import {
  EVENTS_PAGE_SIZE,
  EVENTS_PAGE_SIZE_OPTIONS,
} from "@constants/events.constant";
import {
  eventsListHasAdvancedFilters,
  parseEventsListQuery,
  type PayloadFilters,
  toEventsListQueryParams,
  typeInputFromTypes,
  typesFromInput,
} from "@helper/events-list-query";
import type { ListFilterChip, ListSortOrder } from "@helper/list-query-params";
import {
  listSortOrderToPrime,
  primeSortOrderToList,
  sortFilterValues,
} from "@helper/list-query-params";
import type { PlatformEvent } from "@models/event.model";
import { TranslateModule } from "@ngx-translate/core";
import type { SortEvent } from "primeng/api";
import {
  OpsPaginatorComponent,
  type OpsCursorMove,
  type OpsPageChange,
} from "@modules/shared/ops-paginator/ops-paginator.component";
import { TableEmptyStateComponent } from "@modules/shared/table-empty-state/table-empty-state.component";
import { EventsService } from "@services/implementations/events.service";
import { ButtonModule } from "primeng/button";
import { DatePickerModule } from "primeng/datepicker";
import { InputTextModule } from "primeng/inputtext";
import { AutoCompleteModule } from "primeng/autocomplete";
import { MultiSelectModule } from "primeng/multiselect";
import { SelectModule } from "primeng/select";
import { TableModule } from "primeng/table";
import { catchError, EMPTY, finalize, Subject, switchMap, tap } from "rxjs";

@Component({
  selector: "app-events-page",
  imports: [
    DatePipe,
    FormsModule,
    TranslateModule,
    ButtonModule,
    InputTextModule,
    MultiSelectModule,
    SelectModule,
    AutoCompleteModule,
    DatePickerModule,
    TableModule,
    OpsPaginatorComponent,
    TableEmptyStateComponent,
  ],
  templateUrl: "./events-page.component.html",
  styleUrls: ["./events-page.theme.scss", "./events-page.component.scss"],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: "flex h-full min-h-0 min-w-0 w-full flex-1 flex-col overflow-hidden",
  },
})
export class EventsPageComponent implements OnInit {
  private readonly eventsService = inject(EventsService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly loadListTrigger$ = new Subject<void>();
  readonly locale = inject(LOCALE_ID);

  readonly pageSize = signal<number>(EVENTS_PAGE_SIZE);
  readonly pageSizeOptions = EVENTS_PAGE_SIZE_OPTIONS;
  readonly serviceOptions = signal<string[]>([]);
  /**
   * Event types the store has actually seen, for the type filter's menu.
   *
   * The filter was free text over ten values, so a typo returned an empty list
   * that reads exactly like "nothing of that kind happened" (backlog, closed
   * 2026-09-20). Fetched for the same reason the service list is: a hard-coded
   * constant drifts, and the drift is invisible.
   */
  readonly typeOptions = signal<string[]>([]);

  readonly servicesFilter = signal<string[]>([]);
  readonly typeFilter = signal("");
  readonly correlationIdFilter = signal("");
  readonly entityIdFilter = signal("");
  readonly ownerIdFilter = signal("");
  /**
   * Equality filters on payload fields, e.g. `{ origin: "messenger" }`.
   *
   * `origin` was added to the file events so an audit could tell a chatbot
   * attachment from a messenger one, and then could not be filtered on: the
   * list filters columns and `origin` lives in `payload`. Rather than a column
   * or a param per interesting field, the service matches by containment over
   * one GIN index, so every payload key is filterable and the next publisher to
   * add a field gets this for free.
   *
   * A map, because a deep link can carry several and the service ANDs them.
   * The two inputs below edit one key at a time and leave the others alone.
   */
  readonly payloadFilters = signal<PayloadFilters>({});
  readonly payloadKeyInput = signal("");
  readonly payloadValueInput = signal("");
  /** Field names the service has actually seen, for the field menu. */
  readonly payloadKeyOptions = signal<string[]>([]);
  /** Values seen for the chosen field. Suggestions — typing is still allowed. */
  readonly payloadValueOptions = signal<string[]>([]);
  readonly payloadValueSuggestions = signal<string[]>([]);
  readonly fromFilter = signal<Date | null>(null);
  readonly toFilter = signal<Date | null>(null);
  readonly listOrder = signal<ListSortOrder>("desc");

  readonly rows = signal<PlatformEvent[]>([]);
  readonly total = signal(0);
  /** The service stopped counting at its cap, so `total` is a floor. */
  readonly totalCapped = signal(false);
  /**
   * The cursors followed to get here, one per page past the cap.
   *
   * Empty means ordinary offset paging with page numbers. Non-empty means the
   * list ran out of countable pages and is walking a keyset instead, and the
   * stack is what makes Previous exact — you go back the way you came rather
   * than by arithmetic that has no total to work from.
   *
   * In memory, not in the URL, and deliberately: a cursor is a position in a
   * result set that keeps growing, so a bookmarked one means something
   * different tomorrow. A reload lands on the last numbered page instead,
   * which is the honest place to restart from.
   */
  private readonly cursorStack = signal<string[]>([]);
  /** Cursor for the page after this one, or null when there is none. */
  private readonly nextCursor = signal<string | null>(null);

  readonly cursorMode = computed(() => this.cursorStack().length > 0);
  readonly hasNextCursor = computed(() => this.nextCursor() !== null);
  /** Page number while past the cap: the last numbered page plus the hops. */
  readonly cursorPage = computed(
    () =>
      Math.max(1, Math.ceil(this.total() / this.pageSize())) +
      this.cursorStack().length,
  );
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
      ? "EVENTS_PAGE.PAGINATION.RANGE_CAPPED"
      : "EVENTS_PAGE.PAGINATION.RANGE",
  );
  readonly advancedFiltersOpen = signal(false);
  readonly activeFilters = computed(() => this.buildActiveFilters());
  readonly hasActiveFilters = computed(() => this.activeFilters().length > 0);
  readonly emptyTitleKey = computed(() =>
    this.hasActiveFilters()
      ? "EVENTS_PAGE.EMPTY_FILTERED"
      : "EVENTS_PAGE.EMPTY_UNFILTERED",
  );
  readonly emptyHintKey = computed(() =>
    this.hasActiveFilters()
      ? "EVENTS_PAGE.EMPTY_HINT_FILTERED"
      : "EVENTS_PAGE.EMPTY_HINT_UNFILTERED",
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
    this.loadServiceOptions();
    this.loadTypeOptions();
    this.loadPayloadKeys();

    this.loadListTrigger$
      .pipe(
        tap(() => {
          this.loading.set(true);
          this.listError.set(false);
        }),
        switchMap(() => {
          const types = typesFromInput(this.typeFilter());
          return this.eventsService
            .list({
              services: this.servicesFilter().length
                ? [...this.servicesFilter()]
                : undefined,
              types: types.length ? types : undefined,
              correlationId: this.correlationIdFilter().trim() || undefined,
              entityId: this.entityIdFilter().trim() || undefined,
              ownerId: this.ownerIdFilter().trim() || undefined,
              payload: Object.keys(this.payloadFilters()).length
                ? this.payloadFilters()
                : undefined,
              from: this.toIsoFromFilter(this.fromFilter()),
              to: this.toIsoFromFilter(this.toFilter()),
              limit: this.pageSize(),
              offset: this.offset(),
              after: this.cursorStack().at(-1),
              order: this.listOrder(),
            })
            .pipe(
              finalize(() => this.loading.set(false)),
              catchError(() => {
                this.listError.set(true);
                return EMPTY;
              }),
            );
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((res) => {
        this.rows.set(res.data);
        this.total.set(res.total);
        this.totalCapped.set(res.totalCapped ?? false);
        this.nextCursor.set(res.nextCursor ?? null);
      });

    this.applyQueryState(
      parseEventsListQuery(this.route.snapshot.queryParamMap),
    );
    this.loadList();
  }

  loadList(): void {
    this.loadListTrigger$.next();
  }

  onServicesFilterChange(values: string[]): void {
    this.servicesFilter.set(sortFilterValues(values));
  }

  /**
   * The menu's view of `typeFilter`, which stays the comma-joined string the
   * URL state, the chips and the reset already speak. Keeping one signal of
   * record means the deep-link format is unchanged by this control.
   */
  readonly typesSelected = computed(() => typesFromInput(this.typeFilter()));

  onTypesFilterChange(values: string[]): void {
    this.typeFilter.set(typeInputFromTypes(values));
  }

  onTextFilterInput(
    target: { set: (value: string) => void },
    event: Event,
  ): void {
    target.set((event.target as HTMLInputElement).value);
  }

  onTableSort(event: SortEvent): void {
    const field = event.field ?? "timestamp";
    const nextOrder = primeSortOrderToList(event.order);
    if (field !== "timestamp" || nextOrder === this.listOrder()) {
      return;
    }
    this.listOrder.set(nextOrder);
    // Reversing the sort invalidates the cursor for the same reason.
    this.cursorStack.set([]);
    this.offset.set(0);
    this.syncUrl();
    this.loadList();
  }

  search(): void {
    // A cursor is a position in one result set; changing the filter makes a
    // different one, and carrying it over would page into nothing.
    this.cursorStack.set([]);
    this.servicesFilter.set(sortFilterValues(this.servicesFilter()));
    this.typeFilter.set(typeInputFromTypes(typesFromInput(this.typeFilter())));
    this.commitPayloadInput();
    this.offset.set(0);
    this.syncUrl();
    this.loadList();
  }

  /**
   * Field names come from the data, same as the service filter.
   *
   * Typing a payload key from memory is the part nobody can do — the names are
   * an implementation detail of whichever service published the event.
   */
  private loadPayloadKeys(): void {
    this.eventsService
      .listPayloadKeys()
      .pipe(
        catchError(() => EMPTY),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((keys) => this.payloadKeyOptions.set(keys));
  }

  /**
   * Values for the chosen field, fetched when the field changes.
   *
   * A suggestion list, not a closed set: the service caps it and high-cardinality
   * fields like `call_id` will never be fully listed, so the value control stays
   * free-text with the known values offered.
   */
  onPayloadKeyChange(key: string | null): void {
    this.payloadKeyInput.set(key ?? "");
    this.payloadValueInput.set("");
    this.payloadValueOptions.set([]);
    this.payloadValueSuggestions.set([]);
    if (!key) {
      return;
    }
    this.eventsService
      .listPayloadValues(key)
      .pipe(
        catchError(() => EMPTY),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((values) => {
        this.payloadValueOptions.set(values);
        this.payloadValueSuggestions.set(values);
      });
  }

  /** Filter the suggestions as the user types, keeping free entry. */
  onPayloadValueSearch(event: { query: string }): void {
    const query = event.query.trim().toLowerCase();
    this.payloadValueSuggestions.set(
      query
        ? this.payloadValueOptions().filter((value) =>
            value.toLowerCase().includes(query),
          )
        : [...this.payloadValueOptions()],
    );
  }

  /**
   * Fold the two payload inputs into the map, additively.
   *
   * Setting one key leaves the others in place, so a deep link carrying three
   * pairs does not lose two of them the moment you touch the box. Removing is
   * the chip's job.
   */
  private commitPayloadInput(): void {
    const key = this.payloadKeyInput().trim();
    const value = this.payloadValueInput().trim();
    if (!key || !value) {
      return;
    }
    this.payloadFilters.update((current) => ({ ...current, [key]: value }));
    this.payloadKeyInput.set("");
    this.payloadValueInput.set("");
  }

  clearFilters(): void {
    // A cursor is a position in one result set; changing the filter makes a
    // different one, and carrying it over would page into nothing.
    this.cursorStack.set([]);
    this.servicesFilter.set([]);
    this.typeFilter.set("");
    this.correlationIdFilter.set("");
    this.entityIdFilter.set("");
    this.ownerIdFilter.set("");
    this.payloadFilters.set({});
    this.payloadKeyInput.set("");
    this.payloadValueInput.set("");
    this.payloadValueOptions.set([]);
    this.payloadValueSuggestions.set([]);
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
    if (chipId.startsWith("service:")) {
      const value = chipId.slice("service:".length);
      this.servicesFilter.update((list) => list.filter((s) => s !== value));
    } else if (chipId.startsWith("payload:")) {
      const key = chipId.slice("payload:".length);
      this.payloadFilters.update((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
    } else if (chipId.startsWith("type:")) {
      const value = chipId.slice("type:".length);
      const types = typesFromInput(this.typeFilter()).filter(
        (t) => t !== value,
      );
      this.typeFilter.set(typeInputFromTypes(types));
    } else {
      switch (chipId) {
        case "correlationId":
          this.correlationIdFilter.set("");
          break;
        case "entityId":
          this.entityIdFilter.set("");
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
    // Any numbered move leaves cursor mode: the page it names is an offset.
    this.cursorStack.set([]);
    this.offset.set(event.offset);
    this.pageSize.set(event.pageSize);
    this.syncUrl();
    this.loadList();
  }

  /**
   * First / Previous / Next past the count cap.
   *
   * Next pushes the cursor the service just handed back; Previous pops, and
   * popping the last one drops the list back onto the final numbered page,
   * where the numbers start working again. First leaves cursor mode outright.
   */
  onCursorMove(move: OpsCursorMove): void {
    if (move === "first") {
      this.cursorStack.set([]);
      this.offset.set(0);
      this.syncUrl();
      this.loadList();
      return;
    }

    if (move === "next") {
      const cursor = this.nextCursor();
      if (!cursor) return;
      this.cursorStack.update((stack) => [...stack, cursor]);
      this.loadList();
      return;
    }

    if (this.cursorStack().length === 0) return;
    this.cursorStack.update((stack) => stack.slice(0, -1));
    this.loadList();
  }

  openDetail(record: PlatformEvent): void {
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

  private applyQueryState(
    state: ReturnType<typeof parseEventsListQuery>,
  ): void {
    this.servicesFilter.set(sortFilterValues(state.services));
    this.typeFilter.set(typeInputFromTypes(state.types));
    this.correlationIdFilter.set(state.correlationId);
    this.entityIdFilter.set(state.entityId);
    this.ownerIdFilter.set(state.ownerId);
    this.payloadFilters.set(state.payload);
    this.fromFilter.set(state.from);
    this.toFilter.set(state.to);
    this.offset.set(state.offset);
    this.listOrder.set(state.order);
    this.advancedFiltersOpen.set(eventsListHasAdvancedFilters(state));
  }

  private currentFilterState(): ReturnType<typeof parseEventsListQuery> {
    return {
      services: [...this.servicesFilter()],
      types: typesFromInput(this.typeFilter()),
      correlationId: this.correlationIdFilter(),
      entityId: this.entityIdFilter(),
      ownerId: this.ownerIdFilter(),
      payload: this.payloadFilters(),
      from: this.fromFilter(),
      to: this.toFilter(),
      offset: this.offset(),
      order: this.listOrder(),
    };
  }

  private syncUrl(): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: toEventsListQueryParams(this.currentFilterState()),
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

    for (const service of this.servicesFilter()) {
      chips.push({
        id: `service:${service}`,
        labelKey: "EVENTS_PAGE.FILTERS.CHIP_SERVICE",
        labelParams: { value: service },
      });
    }

    for (const type of typesFromInput(this.typeFilter())) {
      chips.push({
        id: `type:${type}`,
        labelKey: "EVENTS_PAGE.FILTERS.CHIP_TYPE",
        labelParams: { value: type },
      });
    }

    for (const [key, value] of Object.entries(this.payloadFilters())) {
      chips.push({
        id: `payload:${key}`,
        labelKey: "EVENTS_PAGE.FILTERS.CHIP_PAYLOAD",
        labelParams: { key, value },
      });
    }

    const correlationId = this.correlationIdFilter().trim();
    if (correlationId) {
      chips.push({
        id: "correlationId",
        labelKey: "EVENTS_PAGE.FILTERS.CHIP_CORRELATION",
        labelParams: { value: correlationId },
      });
    }

    const entityId = this.entityIdFilter().trim();
    if (entityId) {
      chips.push({
        id: "entityId",
        labelKey: "EVENTS_PAGE.FILTERS.CHIP_ENTITY",
        labelParams: { value: entityId },
      });
    }

    const ownerId = this.ownerIdFilter().trim();
    if (ownerId) {
      chips.push({
        id: "ownerId",
        labelKey: "EVENTS_PAGE.FILTERS.CHIP_OWNER",
        labelParams: { value: ownerId },
      });
    }

    const from = this.formatFilterDate(this.fromFilter());
    if (from) {
      chips.push({
        id: "from",
        labelKey: "EVENTS_PAGE.FILTERS.CHIP_FROM",
        labelParams: { value: from },
      });
    }

    const to = this.formatFilterDate(this.toFilter());
    if (to) {
      chips.push({
        id: "to",
        labelKey: "EVENTS_PAGE.FILTERS.CHIP_TO",
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
   * The filter offers what has actually published, asked once per page load.
   *
   * A failure leaves the list empty, which degrades to "no service filter"
   * rather than to a wrong one — the previous hard-coded list offered a service
   * with zero events and hid the two largest publishers. Nothing else breaks:
   * a bookmarked `?service=` still filters, because the request is built from
   * `servicesFilter` and the chip labels itself from the raw value.
   */
  private loadTypeOptions(): void {
    this.eventsService
      .listTypes()
      .pipe(
        catchError(() => EMPTY),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((types) => this.typeOptions.set(types));
  }

  private loadServiceOptions(): void {
    this.eventsService
      .listServices()
      .pipe(
        catchError(() => EMPTY),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((services) => this.serviceOptions.set(services));
  }
}
