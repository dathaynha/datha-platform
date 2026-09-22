import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  OnInit,
  output,
  signal,
} from "@angular/core";
import { TranslateModule } from "@ngx-translate/core";
import { BrandMarkComponent } from "../brand/brand-mark.component";

/** Entra ID account pool the Microsoft buttons target. */
export type DathaEntraPool = "organizations" | "consumers";

/** Provider ids for the busy indicator. */
export type DathaLoginProvider = "google";

/**
 * Presentational login card: backdrop, frosted card, brand mark, the three
 * platform provider buttons, error and footnote. OAuth logic stays app-side —
 * apps bind busy/error state and react to the click outputs.
 *
 * Copy comes from app i18n catalogs (LOGIN.* keys). Hidden automatically when
 * rendered inside an auth iframe (MSAL silent flows) unless `embeddedGuard`
 * is disabled.
 */
@Component({
  selector: "datha-login-card",
  imports: [TranslateModule, BrandMarkComponent],
  templateUrl: "./login-card.component.html",
  styleUrls: ["./login-card.component.scss"],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LoginCardComponent implements OnInit {
  /** Provider currently authenticating (drives spinner + disabled state). */
  readonly busyProvider = input<DathaLoginProvider | null>(null);
  /** Entra pool currently authenticating. */
  readonly busyEntraPool = input<DathaEntraPool | null>(null);
  /** i18n key of the error to show, or null. */
  readonly errorKey = input<string | null>(null);
  /** Hide the card inside auth iframes (window !== parent). Default true. */
  readonly embeddedGuard = input(true);

  readonly googleLogin = output<void>();
  readonly entraLogin = output<DathaEntraPool>();

  readonly isEmbedded = signal(false);
  readonly isBusy = computed(
    () => this.busyProvider() !== null || this.busyEntraPool() !== null,
  );

  ngOnInit(): void {
    this.isEmbedded.set(
      this.embeddedGuard() && window !== window.parent && !window.opener,
    );
  }
}
