import { Component, computed, inject, input, signal } from "@angular/core";
import { toSignal } from "@angular/core/rxjs-interop";
import {
  NavigationEnd,
  Router,
  RouterLink,
  RouterLinkActive,
} from "@angular/router";
import { filter, map, startWith } from "rxjs";
import { TranslateModule } from "@ngx-translate/core";
import { DrawerModule } from "primeng/drawer";
import { appNameKey, type AppDescriptor } from "@models/index";
import { sweepOrphanedDrawerMasks } from "@modules/shared/drawer-overlay";

/**
 * Destinations the bar renders before it has to spill into the sheet.
 *
 * A constant, not a media query: the failure is about **room**, and every item
 * is `flex-1`, so the bar grows itself whenever a remote is registered and has
 * no width rule to stop it.
 *
 * Measured at 375px, which corrected the assumption this was planned on. The
 * labels do **not** truncate: `truncate` sets `overflow: hidden` on the label,
 * but the label is not the flex item — the link is, and a flex item's
 * automatic minimum size is its content, so each link refuses to shrink below
 * its own word and the **bar** overflows instead. Nothing clips; the right-hand
 * destinations simply leave the screen.
 *
 * | Items | Bar content | State |
 * |---|---|---|
 * | 5 (today) | 375px in 375px | fits |
 * | 6 | 375px in 375px | fits — the words are short enough |
 * | 7 | 390px in 375px | Settings starts leaving the screen |
 * | 10 | 545px in 375px | ~3 destinations unreachable |
 *
 * So the true threshold is the **sum of the label widths**, not the count: it
 * moves with translation and with whatever the next product is called. A count
 * is still the right control — it is predictable and it is where Material 3,
 * Slack, Teams, Gmail and Spotify converge — but it is a conservative stand-in
 * for a measurement, which is why the guard in the spec asserts the overflow
 * rather than this number.
 */
export const BOTTOM_NAV_SLOTS = 5;

@Component({
  selector: "shell-bottom-nav",
  imports: [RouterLink, RouterLinkActive, TranslateModule, DrawerModule],
  templateUrl: "./shell-bottom-nav.component.html",
  styleUrls: ["./shell-bottom-nav.component.scss"],
  // The <nav> inside is the flex item the layout positions; the host must not
  // become a box of its own between them.
  host: { class: "contents" },
})
export class ShellBottomNavComponent {
  private readonly router = inject(Router);

  readonly apps = input.required<AppDescriptor[]>();

  readonly nameKey = appNameKey;

  readonly sheetOpen = signal(false);

  /** Home and Settings are always destinations, whether or not they fit. */
  private readonly destinationCount = computed(() => this.apps().length + 2);

  readonly overflows = computed(
    () => this.destinationCount() > BOTTOM_NAV_SLOTS,
  );

  /**
   * Apps keeping a slot in the bar.
   *
   * Overflow is opt-in at the point it is needed rather than a permanent cap:
   * at five destinations everything fits, so spilling Settings into a sheet
   * would cost a tap and buy nothing. Two slots are reserved when it does
   * spill — Home, and More itself.
   */
  readonly barApps = computed(() =>
    this.overflows() ? this.apps().slice(0, BOTTOM_NAV_SLOTS - 2) : this.apps(),
  );

  readonly sheetApps = computed(() =>
    this.overflows() ? this.apps().slice(BOTTOM_NAV_SLOTS - 2) : [],
  );

  private readonly routerUrl = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map(() => this.normalizeUrl(this.router.url)),
      startWith(this.normalizeUrl(this.router.url)),
    ),
    { initialValue: this.normalizeUrl(this.router.url) },
  );

  /**
   * "You are here" has to reach an item inside the sheet.
   *
   * `routerLinkActive` covers the flat links; More is not a link, so without
   * this a person standing on an overflow product sees no active item anywhere
   * in the bar.
   */
  readonly moreActive = computed(() => {
    if (!this.overflows()) return false;
    const url = this.routerUrl();
    if (this.isUnder(url, "/settings")) return true;
    return this.sheetApps().some((app) => this.isUnder(url, app.route));
  });

  isSheetItemActive(route: string): boolean {
    return this.isUnder(this.routerUrl(), route);
  }

  openSheet(): void {
    this.sheetOpen.set(true);
  }

  closeSheet(): void {
    this.sheetOpen.set(false);
    sweepOrphanedDrawerMasks(() => this.sheetOpen());
  }

  private isUnder(url: string, route: string): boolean {
    return url === route || url.startsWith(`${route}/`);
  }

  private normalizeUrl(url: string): string {
    return url.split("?")[0].split("#")[0];
  }
}
