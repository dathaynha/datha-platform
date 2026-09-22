import {
  Component,
  computed,
  inject,
  OnDestroy,
  OnInit,
  signal,
} from "@angular/core";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { NavigationError, Router, RouterOutlet } from "@angular/router";
import { fade } from "@animations/animations";
import { LOCAL_STORAGE_KEY } from "@constants/index";
import { MessageDialogComponent, type DathaThemeId } from "@datha/platform-ui";
import { TranslateService } from "@ngx-translate/core";
import { AccountSyncService } from "@services/implementations/account-sync.service";
import { AuthenticationService } from "@services/implementations/authentication.service";
import { CommonService } from "@services/implementations/common.service";
import { ShellContextService } from "@services/implementations/shell-context.service";
import { DialogService } from "primeng/dynamicdialog";
import { ProgressSpinner } from "primeng/progressspinner";

@Component({
  selector: "app-root",
  imports: [RouterOutlet, ProgressSpinner],
  templateUrl: "./app.component.html",
  styleUrls: ["./app.component.scss"],
  animations: [fade],
  host: { class: "block min-h-full" },
})
export class AppComponent implements OnInit, OnDestroy {
  private readonly translate = inject(TranslateService);
  private readonly authenticationService = inject(AuthenticationService);
  private readonly accountSync = inject(AccountSyncService);
  private readonly commonService = inject(CommonService);
  private readonly shellContext = inject(ShellContextService);
  private readonly router = inject(Router);
  private readonly dialog = inject(DialogService);

  private tokenRefreshInterval: ReturnType<typeof setInterval> | undefined;

  isLoading = false;
  readonly themeId = signal<DathaThemeId>(this.shellContext.currentThemeId);
  readonly useDarkChrome = computed(() => this.themeId() !== "starlight");

  constructor() {
    this.commonService.loading$.subscribe((loading) => {
      this.isLoading = loading;
    });
    this.shellContext.theme$.pipe(takeUntilDestroyed()).subscribe((t) => {
      this.themeId.set(t);
      this.syncDocumentDarkClass(t);
    });
    this.router.events.pipe(takeUntilDestroyed()).subscribe((event) => {
      if (event instanceof NavigationError) {
        this.showRemoteUnavailableDialog(event);
      }
    });
  }

  /** Remote failed to load (offline / unreachable) — router swallows the rejection silently otherwise. */
  private showRemoteUnavailableDialog(event: NavigationError): void {
    console.error(`Failed to navigate to ${event.url}:`, event.error);
    this.dialog.open(MessageDialogComponent, {
      data: {
        titleKey: "REMOTE_UNAVAILABLE.title",
        messageKey: "REMOTE_UNAVAILABLE.message",
      },
      closable: true,
      modal: true,
      width: "min(480px, 92vw)",
    });
  }

  ngOnInit(): void {
    const language = localStorage.getItem(LOCAL_STORAGE_KEY.LANGUAGE);
    if (language) {
      this.translate.use(language);
    }

    if (this.authenticationService.isAuthenticated()) {
      this.startTokenRefreshInterval();
      // Provisions this user in accounts-service. Without it the directory has
      // no row for them and nobody can find them to start a conversation.
      void this.accountSync.sync();
    }
  }

  ngOnDestroy(): void {
    if (this.tokenRefreshInterval) {
      clearInterval(this.tokenRefreshInterval);
    }
    if (typeof document !== "undefined") {
      document.documentElement.classList.remove("dark");
    }
  }

  /** PrimeNG Aura dark tokens + overlays expect `.dark` on a document ancestor, not only `app-shell`. */
  private syncDocumentDarkClass(theme: DathaThemeId): void {
    if (typeof document === "undefined") {
      return;
    }
    document.documentElement.classList.toggle("dark", theme !== "starlight");
  }

  private startTokenRefreshInterval(): void {
    if (this.tokenRefreshInterval) {
      clearInterval(this.tokenRefreshInterval);
    }
    this.tokenRefreshInterval = setInterval(
      () => {
        void this.authenticationService.refreshToken();
      },
      60 * 60 * 1000,
    );
  }
}
