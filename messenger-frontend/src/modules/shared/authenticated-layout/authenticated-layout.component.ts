import { Component, computed, inject, OnInit, signal } from "@angular/core";
import { ActivatedRoute, RouterOutlet } from "@angular/router";
import { LOCAL_STORAGE_KEY } from "@constants/index";
import {
  LangSelectComponent,
  ProfilePopoverComponent,
  registerRemoteTranslations,
  SubHeaderComponent,
  ThemeSelectComponent,
  normalizeDathaThemeId,
  type DathaSubHeaderTab,
  type DathaThemeId,
  type DathaProfileMenuItem,
} from "@datha/platform-ui";
import { User } from "@models/index";
import {
  TranslateModule,
  TranslateService,
  TranslateStore,
} from "@ngx-translate/core";
import {
  AuthProvider,
  AuthenticationService,
} from "@services/implementations/authentication.service";
import { CommonService } from "@services/implementations/common.service";
import { ThemeService } from "@services/implementations/theme.service";
import { OAuthEvent, OAuthService } from "angular-oauth2-oidc";
import { filter } from "rxjs";
import { environment } from "src/environments/environment";
import { REMOTE_TRANSLATION_BUNDLES } from "src/i18n/remote-translation-bundles";
import { ButtonModule } from "primeng/button";
import { CallDockComponent } from "src/modules/call-dock/call-dock.component";
import { ChatDockComponent } from "src/modules/chat-dock/chat-dock.component";
import { RealtimeService } from "@services/implementations/realtime.service";

@Component({
  selector: "authenticated-layout",
  imports: [
    RouterOutlet,
    TranslateModule,
    ButtonModule,
    SubHeaderComponent,
    ThemeSelectComponent,
    LangSelectComponent,
    ProfilePopoverComponent,
    CallDockComponent,
    ChatDockComponent,
  ],
  templateUrl: "./authenticated-layout.component.html",
  styleUrls: ["./authenticated-layout.component.scss"],
  host: { class: "flex min-h-0 w-full flex-1 flex-col" },
})
export class AuthenticatedLayoutComponent implements OnInit {
  private readonly translate = inject(TranslateService);
  private readonly translateStore = inject(TranslateStore);
  private readonly oAuthService = inject(OAuthService);
  private readonly commonService = inject(CommonService);
  private readonly authenticationService = inject(AuthenticationService);
  private readonly themeService = inject(ThemeService);
  private readonly route = inject(ActivatedRoute);

  readonly applicationName = environment.email.applicationName;
  readonly recipients = environment.email.recipients;

  /** True when this layout is rendered inside the shell (MF remote mode). */
  readonly isShelled = signal(false);

  /** Absolute router paths that change depending on hosting context. */
  readonly overviewLink = signal<string[]>(["/"]);
  readonly chatsLink = signal<string[]>(["/chats"]);

  // Calls and People tabs arrive with their features (phases 2 and 1) — an empty
  // tab is worse than an absent one.
  readonly tabs = computed<DathaSubHeaderTab[]>(() => [
    {
      id: "overview",
      labelKey: "SUBNAV.OVERVIEW",
      route: this.overviewLink(),
      exact: true,
    },
    { id: "chats", labelKey: "SUBNAV.CHATS", route: this.chatsLink() },
  ]);

  readonly languages = Object.keys(environment.localeMap);
  readonly selectedLanguage = signal("en");
  readonly selectedTheme = signal<DathaThemeId>("starlight");

  private readonly realtime = inject(RealtimeService);

  ngOnInit(): void {
    const shelled = !!this.route.snapshot.data["shelled"];
    this.isShelled.set(shelled);
    if (!shelled) {
      /*
       * The ambient socket the shell's header widget provides when hosted.
       *
       * Standalone, the only other caller is the chats page, so a call could
       * not ring anyone sitting on the Overview page — and ringing from
       * anywhere is the whole reason the widget is mounted at login rather
       * than on first visit to a thread. Idempotent, so the chats page
       * starting it again costs nothing.
       */
      this.realtime.start();
    }
    if (shelled) {
      this.overviewLink.set(["/messenger"]);
      this.chatsLink.set(["/messenger/chats"]);
      registerRemoteTranslations(
        this.translate,
        this.translateStore,
        REMOTE_TRANSLATION_BUNDLES,
      );
    }

    const stored =
      localStorage.getItem(LOCAL_STORAGE_KEY.LANGUAGE) ||
      this.translate.currentLang ||
      "en";
    this.selectedLanguage.set(this.languages.includes(stored) ? stored : "en");

    this.selectedTheme.set(
      normalizeDathaThemeId(localStorage.getItem(LOCAL_STORAGE_KEY.THEME)),
    );
    this.themeService.theme$.subscribe((theme) => {
      if (theme) {
        this.selectedTheme.set(normalizeDathaThemeId(theme));
      }
    });

    if (this.oAuthService.getAccessToken()) {
      this.syncCurrentUserFromOidc();
    }
    this.oAuthService.events
      .pipe(filter((e: OAuthEvent) => e.type === "token_received"))
      .subscribe(() => {
        this.syncCurrentUserFromOidc();
      });
  }

  onLanguageChange(lang: string): void {
    if (!lang) {
      return;
    }
    this.translate.use(lang);
    localStorage.setItem(LOCAL_STORAGE_KEY.LANGUAGE, lang);
    this.selectedLanguage.set(lang);
  }

  onThemeChange(theme: DathaThemeId): void {
    if (!theme) {
      return;
    }
    this.themeService.setTheme(theme);
    this.selectedTheme.set(theme);
  }

  logout(): void {
    this.authenticationService.logout();
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

  profileClaims(): Record<string, unknown> | null {
    return this.oAuthService.getIdentityClaims() as Record<
      string,
      unknown
    > | null;
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
    const claims = this.profileClaims();
    if (!claims) {
      return "";
    }
    for (const key of keys) {
      const v = claims[key];
      if (typeof v === "string") {
        const t = v.trim();
        if (t.length > 0) {
          return t;
        }
      }
    }
    return "";
  }

  /**
   * Standalone only: when hosted, the shell owns the profile menu and carries
   * its own support item. Support left the sub-header because it cost 130px of
   * a 390px screen beside the primary tabs, for a mailto nobody opens weekly.
   */
  readonly profileMenuItems: DathaProfileMenuItem[] = [
    { id: "support", labelKey: "SUBNAV.SUPPORT", icon: "pi-envelope" },
  ];

  onProfileMenuItem(item: DathaProfileMenuItem): void {
    if (item.id === "support") this.sendEmail();
  }

  sendEmail(): void {
    const subject = this.translate.instant("EMAIL.SUBJECT");
    const body = this.translate.instant("EMAIL.BODY", {
      applicationName: this.applicationName,
    });
    window.location.href = `mailto:${this.recipients.join(",")}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  }

  /** Aligns with api-gateway JWT subject: `google_<sub>` or `entra_<oid>`. */
  private ownerIdFromOidcClaims(sub: string, oid: string): string {
    const provider = localStorage.getItem(LOCAL_STORAGE_KEY.AUTH_PROVIDER);
    if (provider === AuthProvider.ENTRA) {
      const id = oid || sub;
      return id ? `entra_${id}` : "";
    }
    return sub ? `google_${sub}` : "";
  }

  /** Map OIDC id_token claims to `User` (no external user-info API). */
  private syncCurrentUserFromOidc(): void {
    if (this.commonService.getCurrentUser()) {
      return;
    }
    const claims = this.oAuthService.getIdentityClaims() as Record<
      string,
      unknown
    > | null;
    if (!claims) {
      return;
    }
    const email = String(claims["email"] ?? "");
    const sub = String(claims["sub"] ?? "");
    const oid = String(claims["oid"] ?? "");
    const name = String(
      (claims["name"] ?? claims["given_name"] ?? email) || "User",
    );
    const userName = String(
      (claims["preferred_username"] ?? email ?? sub) || "user",
    );
    const userId = this.ownerIdFromOidcClaims(sub, oid);
    if (!email && !userId) {
      return;
    }
    const user: User = {
      userId: userId || email,
      name,
      email: email || userName,
      userName,
    };
    this.commonService.setCurrentUser(user);
  }
}
