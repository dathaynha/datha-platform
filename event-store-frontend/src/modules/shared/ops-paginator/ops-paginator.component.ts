import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from "@angular/core";
import { FormsModule } from "@angular/forms";
import { TranslateModule } from "@ngx-translate/core";
import { ButtonModule } from "primeng/button";
import { SelectModule } from "primeng/select";

/** A page link, or the gap between two runs of them. */
export type PageLink = number | "gap";

/** What a page change asks the list for. */
export interface OpsPageChange {
  offset: number;
  pageSize: number;
}

/**
 * A move that cannot be expressed as an offset.
 *
 * Past the count cap there is no page number to jump to and no total to
 * subtract from, so the only honest moves are "one more", "the one I came
 * from", and "take me back to the start". The list owns the cursors; this
 * control only says which way.
 */
export type OpsCursorMove = "first" | "prev" | "next";

/**
 * Pagination for the ops lists.
 *
 * PrimeNG's own paginator was used first and had to go: its page links are a
 * fixed sliding window with no ellipsis and no boundary pages, so a 15-page
 * list offered "1 2 3 4 5" and no hint that 15 existed — five consecutive
 * numbers is the least useful five you can show (dathq, 2026-09-19). The
 * component exposes `pageLinkSize` and nothing that would add the gaps, so the
 * links are ours; everything else is still PrimeNG.
 *
 * The rule the links follow is the common one: **the first page, the last page,
 * the current page and its neighbours, with a gap standing in for each run that
 * is skipped.** That keeps the control a fixed width whatever the page count,
 * which is the other half of why a sliding window is wrong — it tells you
 * nothing about where the end is.
 */
@Component({
  selector: "es-ops-paginator",
  imports: [ButtonModule, SelectModule, FormsModule, TranslateModule],
  templateUrl: "./ops-paginator.component.html",
  styleUrls: ["./ops-paginator.component.scss"],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OpsPaginatorComponent {
  readonly offset = input.required<number>();
  readonly pageSize = input.required<number>();
  readonly total = input.required<number>();
  /**
   * `total` is a floor, not a count — the service stopped counting at its cap.
   *
   * The page numbers stay honest by being the pages that exist *within* the
   * cap; what changes is that the last one is not the last, so it is marked
   * with a "+". Paging past the cap is deliberately not offered: a deep
   * `OFFSET` costs exactly what the cap exists to avoid.
   */
  readonly totalCapped = input(false);
  readonly pageSizeOptions = input<number[]>([10, 30, 50]);
  readonly disabled = input(false);

  /**
   * Past the cap, where the numbers stop meaning anything.
   *
   * The links and the Last button go — there is no known last — and the
   * readout becomes a running page number. Everything else stays put so the
   * control does not jump under the cursor when it crosses over.
   */
  readonly cursorMode = input(false);
  /** Display-only page number while in cursor mode. */
  readonly cursorPage = input(1);
  /** Whether the service handed back another cursor to follow. */
  readonly hasNextCursor = input(false);

  readonly pageChange = output<OpsPageChange>();
  readonly cursorMove = output<OpsCursorMove>();

  readonly pageCount = computed(() =>
    Math.max(1, Math.ceil(this.total() / this.pageSize())),
  );

  /** 1-based, because every number this component renders is. */
  readonly currentPage = computed(() =>
    Math.min(this.pageCount(), Math.floor(this.offset() / this.pageSize()) + 1),
  );

  /** "15" or "15+", for the readout that replaces the links on a phone. */
  readonly pageCountLabel = computed(
    () => `${this.pageCount()}${this.totalCapped() ? "+" : ""}`,
  );

  /** "3 / 15" normally; past the cap there is no denominator to show. */
  readonly positionLabel = computed(() =>
    this.cursorMode()
      ? String(this.cursorPage())
      : `${this.currentPage()} / ${this.pageCountLabel()}`,
  );

  readonly isFirst = computed(() =>
    this.cursorMode() ? false : this.currentPage() <= 1,
  );

  /**
   * Whether Next is the end of the road.
   *
   * On the last *numbered* page of a capped total it deliberately is not: the
   * rows keep going, and that press is what hands the list over to the cursor.
   * Stopping there would strand someone at the cap with data still below them,
   * which is worse than the prev/next this paginator replaced.
   *
   * But only when there is a cursor to follow. `hasNextCursor` is the whole
   * precondition and the only honest one: a list whose service does not issue
   * cursors never binds it, so the crossing is never offered there. Keying this
   * on `totalCapped` alone left the DLQ list — which is capped but has no
   * cursor paging — with an enabled Next that emitted into an output nobody had
   * subscribed to, and therefore did nothing at all.
   */
  readonly isLast = computed(() => {
    if (this.cursorMode()) {
      return !this.hasNextCursor();
    }
    if (this.currentPage() < this.pageCount()) {
      return false;
    }
    return !(this.totalCapped() && this.hasNextCursor());
  });

  /**
   * The Last button jumps to `pageCount()`, so it is spent once you are there.
   *
   * It cannot share `isLast()`: that answers "can Next still go somewhere",
   * which on a capped list is *true* on the last numbered page because the
   * cursor takes over — while Last has nowhere left to jump to. Sharing them
   * left Last enabled on the page it would have taken you to.
   */
  readonly isAtLastNumberedPage = computed(
    () => this.currentPage() >= this.pageCount(),
  );

  readonly sizeOptions = computed(() =>
    this.pageSizeOptions().map((size) => ({
      label: String(size),
      value: size,
    })),
  );

  /**
   * First, last, current and its neighbours — with a gap for each skipped run.
   *
   * Seven or fewer pages are all shown: the gap would replace a single number
   * with an ellipsis of the same width, which buys nothing and costs a click.
   */
  readonly links = computed<PageLink[]>(() => {
    const count = this.pageCount();
    const current = this.currentPage();
    if (count <= 7)
      return Array.from({ length: count }, (_, index) => index + 1);

    const pages = new Set<number>([1, count, current]);
    if (current - 1 > 1) pages.add(current - 1);
    if (current + 1 < count) pages.add(current + 1);

    // Near an end the window is lopsided, so top it back up to a steady width —
    // otherwise the control visibly narrows on page 1 and page N.
    if (current <= 3) [2, 3, 4].forEach((page) => pages.add(page));
    if (current >= count - 2)
      [count - 3, count - 2, count - 1].forEach((page) => pages.add(page));

    const sorted = [...pages]
      .filter((p) => p >= 1 && p <= count)
      .sort((a, b) => a - b);
    const out: PageLink[] = [];
    let previous = 0;
    for (const page of sorted) {
      if (previous && page - previous > 1) out.push("gap");
      out.push(page);
      previous = page;
    }
    return out;
  });

  protected isGap(link: PageLink): link is "gap" {
    return link === "gap";
  }

  protected goToPage(page: number): void {
    if (this.disabled()) return;
    const target = Math.min(Math.max(1, page), this.pageCount());
    if (target === this.currentPage()) return;
    this.pageChange.emit({
      offset: (target - 1) * this.pageSize(),
      pageSize: this.pageSize(),
    });
  }

  /** First / Prev / Next, in whichever mode the control is currently in. */
  protected step(move: OpsCursorMove): void {
    if (this.disabled()) return;
    if (this.cursorMode() || (move === "next" && this.isCrossingTheCap())) {
      this.cursorMove.emit(move);
      return;
    }
    this.goToPage(
      move === "first" ? 1 : this.currentPage() + (move === "next" ? 1 : -1),
    );
  }

  /** The one offset-mode press that hands over to the cursor. */
  private isCrossingTheCap(): boolean {
    return (
      this.totalCapped() &&
      this.hasNextCursor() &&
      this.currentPage() >= this.pageCount()
    );
  }

  /**
   * Changing the size keeps the **first visible record** rather than the page
   * number, so the row you were looking at stays on screen. Page 3 of 50 is
   * record 101; at 10 a page that is page 11, not page 3.
   */
  protected onSizeChange(size: number): void {
    if (!size || size === this.pageSize()) return;
    const firstVisible = this.offset();
    this.pageChange.emit({
      offset: Math.floor(firstVisible / size) * size,
      pageSize: size,
    });
  }
}
