import { Component, computed, inject, OnInit, signal } from "@angular/core";
import { toSignal } from "@angular/core/rxjs-interop";
import {
  NavigationEnd,
  Router,
  RouterLink,
  RouterLinkActive,
  RouterOutlet,
} from "@angular/router";
import { filter, map, startWith } from "rxjs";
import { LOCAL_STORAGE_KEY } from "@constants/index";
import { TranslateModule, TranslateService } from "@ngx-translate/core";
import {
  AuthProvider,
  AuthenticationService,
} from "@services/implementations/authentication.service";
import { ShellContextService } from "@services/implementations/shell-context.service";
import { OAuthService } from "angular-oauth2-oidc";
import {
  BrandMarkComponent,
  LangSelectComponent,
  ProfilePopoverComponent,
  ThemeSelectComponent,
  type DathaProfileMenuItem,
  type DathaThemeId,
} from "@datha/platform-ui";
import { environment } from "src/environments/environment";
import { ButtonModule } from "primeng/button";
import { ToolbarModule } from "primeng/toolbar";
import { TooltipModule } from "primeng/tooltip";
import { HeaderWidgetHostComponent } from "@modules/shared/header-widget-host/header-widget-host.component";
import { NotificationBellComponent } from "@modules/shared/notification-bell/notification-bell.component";
import { ShellBottomNavComponent } from "@modules/shared/shell-bottom-nav/shell-bottom-nav.component";
import { appNameKey, type AppDescriptor } from "@models/index";

@Component({
  selector: "authenticated-layout",
  imports: [
    RouterLink,
    RouterLinkActive,
    RouterOutlet,
    TranslateModule,
    ToolbarModule,
    ButtonModule,
    TooltipModule,
    BrandMarkComponent,
    ThemeSelectComponent,
    LangSelectComponent,
    ProfilePopoverComponent,
    HeaderWidgetHostComponent,
    NotificationBellComponent,
    ShellBottomNavComponent,
  ],
  templateUrl: "./authenticated-layout.component.html",
  styleUrls: ["./authenticated-layout.component.scss"],
  host: { class: "block" },
})
export class AuthenticatedLayoutComponent implements OnInit {
  private readonly translate = inject(TranslateService);
  private readonly oAuthService = inject(OAuthService);
  private readonly authenticationService = inject(AuthenticationService);
  private readonly shellContext = inject(ShellContextService);
  private readonly router = inject(Router);

  readonly apps: AppDescriptor[] =
    (environment as { apps?: AppDescriptor[] }).apps ?? [];

  readonly nameKey = appNameKey;

  /**
   * Settings, and support.
   *
   * Support used to be a text button in each remote's own sub-header, where it
   * cost 130px of a 390px screen — a third of the width, next to the primary
   * tabs, for a mailto nobody opens weekly (dathq, 2026-09-17). Placement
   * follows frequency, so it belongs with the other rare action already here.
   *
   * It has to exist *here* as well as in the remotes, because when a remote is
   * hosted the shell owns the profile menu and the remote's own is not
   * rendered — moving it out of the sub-header without this would have made
   * support unreachable in the normal, shelled case.
   */
  readonly profileMenuItems: DathaProfileMenuItem[] = [
    { id: "settings", labelKey: "SETTINGS.NAV", icon: "pi-cog" },
    { id: "support", labelKey: "PROFILE.SUPPORT", icon: "pi-envelope" },
  ];

  onProfileMenuItem(item: DathaProfileMenuItem): void {
    if (item.id === "settings") void this.router.navigateByUrl("/settings");
    if (item.id === "support") this.sendEmail();
  }

  /**
   * Opens a support mail, prefilled.
   *
   * `environment.email` has been configured in this repo the whole time and
   * nothing read it — the remotes each had their own copy of this method.
   */
  private sendEmail(): void {
    const { applicationName, recipients } = environment.email;
    const subject = this.translate.instant("EMAIL.SUBJECT");
    const body = this.translate.instant("EMAIL.BODY", { applicationName });
    window.location.href = `mailto:${recipients.join(",")}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  }

  readonly sidebarCollapsed = signal(
    localStorage.getItem(LOCAL_STORAGE_KEY.SIDEBAR_COLLAPSED) === "true",
  );

  private readonly routerUrl = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map(() => this.normalizeRouterUrl(this.router.url)),
      startWith(this.normalizeRouterUrl(this.router.url)),
    ),
    { initialValue: this.normalizeRouterUrl(this.router.url) },
  );

  readonly activeApp = computed(() => this.findActiveApp(this.routerUrl()));

  /** Key, not text: the brand line must re-translate on language change. */
  readonly activeAppNameKey = computed(() => {
    const app = this.activeApp();
    return app ? appNameKey(app) : "";
  });

  toggleSidebar(): void {
    this.sidebarCollapsed.update((v) => {
      const next = !v;
      localStorage.setItem(LOCAL_STORAGE_KEY.SIDEBAR_COLLAPSED, String(next));
      return next;
    });
  }

  readonly languages = Object.keys(environment.localeMap);
  selectedLanguage = "en";

  selectedTheme: DathaThemeId = "starlight";

  ngOnInit(): void {
    const stored =
      localStorage.getItem(LOCAL_STORAGE_KEY.LANGUAGE) ||
      this.translate.currentLang ||
      "en";
    this.selectedLanguage = this.languages.includes(stored) ? stored : "en";

    this.selectedTheme = this.shellContext.currentThemeId;
  }

  onLanguageChange(lang: string): void {
    if (!lang) return;
    this.shellContext.setLang(lang);
    this.selectedLanguage = lang;
  }

  onThemeChange(theme: DathaThemeId): void {
    if (!theme) return;
    this.shellContext.setTheme(theme);
    this.selectedTheme = theme;
  }

  logout(): void {
    this.shellContext.logout();
  }

  isActiveRemote(app: AppDescriptor): boolean {
    return this.isAppRouteActive(this.router.url, app.route);
  }

  private findActiveApp(url: string): AppDescriptor | null {
    if (!url || url === "/") return null;
    const sorted = [...this.apps].sort(
      (a, b) => b.route.length - a.route.length,
    );
    return sorted.find((app) => this.isAppRouteActive(url, app.route)) ?? null;
  }

  private isAppRouteActive(url: string, route: string): boolean {
    const path = this.normalizeRouterUrl(url);
    return path === route || path.startsWith(`${route}/`);
  }

  private normalizeRouterUrl(url: string): string {
    return url.split("?")[0].split("#")[0];
  }

  providerLabelKey(): string {
    switch (this.authenticationService.getResolvedAuthProvider()) {
      case AuthProvider.GOOGLE:
        return "PROFILE.METHOD_GOOGLE";
      case AuthProvider.ENTRA:
        return "PROFILE.METHOD_MICROSOFT";
      default:
        return "PROFILE.METHOD_UNKNOWN";
    }
  }

  profileDisplayName(): string {
    return (
      this.firstClaimString([
        "name",
        "given_name",
        "nickname",
        "preferred_username",
        "email",
      ]) || this.translate.instant("PROFILE.FIELD_EMPTY")
    );
  }

  profileEmail(): string {
    return (
      this.firstClaimString(["email", "upn"]) ||
      this.translate.instant("PROFILE.FIELD_EMPTY")
    );
  }

  profileUsername(): string {
    return (
      this.firstClaimString(["preferred_username", "unique_name"]) ||
      this.translate.instant("PROFILE.FIELD_EMPTY")
    );
  }

  showUsernameRow(): boolean {
    const email = this.firstClaimString(["email", "upn"]);
    const user = this.firstClaimString(["preferred_username", "unique_name"]);
    return !!user && user !== email;
  }

  private firstClaimString(keys: string[]): string {
    const claims = this.oAuthService.getIdentityClaims() as Record<
      string,
      unknown
    > | null;
    if (!claims) return "";
    for (const key of keys) {
      const v = claims[key];
      if (typeof v === "string") {
        const t = v.trim();
        if (t.length > 0) return t;
      }
    }
    return "";
  }
}
