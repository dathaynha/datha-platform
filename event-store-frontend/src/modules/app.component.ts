import { Component, OnDestroy, OnInit } from "@angular/core";
import { RouterOutlet } from "@angular/router";
import { fade } from "@animations/animations";
import { LOCAL_STORAGE_KEY } from "@constants/index";
import { TranslateService } from "@ngx-translate/core";
import { AuthenticationService } from "@services/implementations/authentication.service";
import { CommonService } from "@services/implementations/common.service";
import { ThemeService } from "@services/implementations/theme.service";
import { normalizeDathaThemeId, type DathaThemeId } from "@datha/platform-ui";
import { ProgressSpinner } from "primeng/progressspinner";

@Component({
  selector: "app-root",
  imports: [RouterOutlet, ProgressSpinner],
  templateUrl: "./app.component.html",
  animations: [fade],
  host: {
    class:
      "box-border block min-h-full font-sans text-sm antialiased text-surface-800",
  },
})
export class AppComponent implements OnInit, OnDestroy {
  private tokenRefreshInterval: ReturnType<typeof setInterval>;

  isLoading = false;
  themeClass: string = "";
  themeId: DathaThemeId = "starlight";

  constructor(
    private authenticationService: AuthenticationService,
    private translate: TranslateService,
    private themeService: ThemeService,
    private commonService: CommonService,
  ) {
    this.subscribeToLoading();
    this.watchTheme();
  }

  async ngOnInit() {
    const language = localStorage.getItem(LOCAL_STORAGE_KEY.LANGUAGE);
    if (language) {
      this.translate.use(language);
    }

    if (this.authenticationService.isAuthenticated()) {
      this.startTokenRefreshInterval();
      this.checkLoginTime();
    }
  }

  ngOnDestroy() {
    if (this.tokenRefreshInterval) {
      clearInterval(this.tokenRefreshInterval);
    }
    if (typeof document !== "undefined") {
      document.documentElement.classList.remove("dark");
      delete document.documentElement.dataset["shellTheme"];
    }
  }

  private subscribeToLoading() {
    this.commonService.loading$.subscribe((loading) => {
      this.isLoading = loading;
    });
  }

  private watchTheme() {
    const themeClassLocalStorage = localStorage.getItem(
      LOCAL_STORAGE_KEY.THEME,
    );
    this.applyTheme(themeClassLocalStorage);

    this.themeService.theme$.subscribe((themeClass: string | null) => {
      this.applyTheme(themeClass);
    });
  }

  private applyTheme(theme: string | null): void {
    const themeId = normalizeDathaThemeId(theme);
    this.themeId = themeId;
    this.themeClass = themeId === "starlight" ? "" : "dark";
    this.syncDocumentDarkClass(themeId);
  }

  /** PrimeNG Aura dark tokens + overlays expect `.dark` on a document ancestor. */
  private syncDocumentDarkClass(theme: DathaThemeId): void {
    if (typeof document === "undefined") {
      return;
    }
    document.documentElement.classList.toggle("dark", theme !== "starlight");
    document.documentElement.dataset["shellTheme"] = theme;
  }

  checkLoginTime() {
    const loginTime = localStorage.getItem(LOCAL_STORAGE_KEY.LOGIN_TIME);
    if (loginTime) {
      const currentTime = new Date().getTime();
      const elapsedHours =
        (currentTime - parseInt(loginTime, 10)) / (1000 * 60 * 60);

      if (elapsedHours >= 8) {
        this.authenticationService.logout();
      }
    }
  }

  private startTokenRefreshInterval() {
    if (this.tokenRefreshInterval) {
      clearInterval(this.tokenRefreshInterval);
    }

    this.tokenRefreshInterval = setInterval(
      () => {
        this.authenticationService.refreshToken();
        this.checkLoginTime();
      },
      60 * 60 * 1000,
    );
  }
}
