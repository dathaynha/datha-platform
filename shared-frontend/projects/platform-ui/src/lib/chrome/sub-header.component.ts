import { ChangeDetectionStrategy, Component, input } from "@angular/core";
import { RouterLink, RouterLinkActive } from "@angular/router";
import { TranslateModule } from "@ngx-translate/core";

/** One tab in a {@link SubHeaderComponent}. */
export interface DathaSubHeaderTab {
  /** Stable id — used as the `@for` track key. */
  id: string;
  /** Consumer-side i18n key for the visible label. */
  labelKey: string;
  /** `routerLink` commands. Absolute paths differ hosted vs standalone. */
  route: string | readonly string[];
  /** Match the route exactly — set on landing/overview tabs. */
  exact?: boolean;
}

/**
 * Slim product sub-header for Module Federation remotes: glass bar with
 * router tabs on the left and projected chrome controls on the right.
 *
 * Tabs are real anchors, not buttons: middle-click and open-in-new-tab work,
 * `routerLinkActive` owns the active state, and screen readers get link role
 * plus `aria-current="page"`. That is also why the lib depends on
 * `@angular/router` — link semantics, not navigation policy (which target a
 * tab points at stays entirely consumer-side).
 *
 * Colours come from the `--datha-chrome-*` tokens so this bar and the shell
 * sidebar cannot drift apart.
 *
 * i18n namespace warning: since v0.6.1 `registerRemoteTranslations` merges a
 * remote's leaves over the host's baseline, so reusing a namespace the shell
 * owns (`NAV`, `BRAND`, `SETTINGS`, `PROFILE`, `APPS`, …) no longer erases the
 * shell's other keys in it — but a **leaf** a remote also defines still wins
 * while that remote is mounted. Prefer `SUBNAV.*` for anything of a remote's
 * own. `PROFILE.*` is the deliberate exception: this library hardcodes those
 * keys, so every remote must ship them to work standalone.
 *
 * ```html
 * <datha-sub-header [tabs]="tabs" navAriaLabelKey="NAV.ARIA">
 *   <p-button [text]="true" [label]="'NAV.SUPPORT' | translate" />
 * </datha-sub-header>
 * ```
 */
@Component({
  selector: "datha-sub-header",
  imports: [RouterLink, RouterLinkActive, TranslateModule],
  templateUrl: "./sub-header.component.html",
  styleUrls: ["./sub-header.component.scss"],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SubHeaderComponent {
  readonly tabs = input<readonly DathaSubHeaderTab[]>([]);
  /** i18n key for the `<nav>` accessible name (multiple navs per page). */
  readonly navAriaLabelKey = input<string>("");
}
