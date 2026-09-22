import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
  viewChild,
} from "@angular/core";
import { TranslateModule } from "@ngx-translate/core";
import { ButtonModule } from "primeng/button";
import { Popover, PopoverModule } from "primeng/popover";

/**
 * Menu entry rendered between the identity rows and the logout footer.
 * Opt-in per host: apps only pass entries whose targets exist in their
 * router (e.g. the shell passes Settings; standalone remotes pass none).
 */
export interface DathaProfileMenuItem {
  /** Stable id, echoed on `menuItemSelect`. */
  id: string;
  /** Consumer-side i18n key for the label. */
  labelKey: string;
  /** PrimeIcons class without the `pi` prefix (e.g. "pi-cog"). */
  icon?: string;
}

/**
 * Profile trigger button + popover for shell/standalone toolbars. Purely
 * presentational: the app resolves the display strings and reacts to
 * `logout` / `menuItemSelect` (navigation stays consumer-side — the lib
 * has no Router dependency). Rows with empty values are hidden.
 *
 * Consumer i18n keys: PROFILE.MENU_ARIA, PROFILE.TITLE, PROFILE.NAME,
 * PROFILE.EMAIL, PROFILE.USERNAME, PROFILE.SIGN_IN_METHOD, PROFILE.LOG_OUT,
 * plus whatever key is passed as `signInMethodKey` and per-item `labelKey`s.
 */
@Component({
  selector: "datha-profile-popover",
  imports: [TranslateModule, ButtonModule, PopoverModule],
  templateUrl: "./profile-popover.component.html",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProfilePopoverComponent {
  readonly name = input<string>("");
  readonly email = input<string>("");
  readonly username = input<string>("");
  /** i18n key for the sign-in method label (e.g. "PROFILE.PROVIDER_GOOGLE"). */
  readonly signInMethodKey = input<string>("");
  readonly menuItems = input<DathaProfileMenuItem[]>([]);

  readonly logout = output<void>();
  readonly menuItemSelect = output<DathaProfileMenuItem>();

  readonly popover = viewChild.required<Popover>("profilePopover");

  onLogout(): void {
    this.popover().hide();
    this.logout.emit();
  }

  onMenuItem(item: DathaProfileMenuItem): void {
    this.popover().hide();
    this.menuItemSelect.emit(item);
  }
}
