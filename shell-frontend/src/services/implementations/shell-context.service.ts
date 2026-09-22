import { Injectable } from "@angular/core";
import { TranslateService } from "@ngx-translate/core";
import { OAuthEvent, OAuthService } from "angular-oauth2-oidc";
import { BehaviorSubject } from "rxjs";
import { filter } from "rxjs/operators";
import { LOCAL_STORAGE_KEY } from "@constants/index";
import type {
  OwnerProfile,
  ShellContext,
} from "@constants/injection-token.constant";
import { normalizeDathaThemeId, type DathaThemeId } from "@datha/platform-ui";
import { AuthenticationService } from "./authentication.service";

/**
 * Implements ShellContext and is provided as the SHELL_CONTEXT token.
 * Angular remotes loaded via federation receive this instance directly.
 */
@Injectable({
  providedIn: "root",
})
export class ShellContextService implements ShellContext {
  private readonly authTokenSubject = new BehaviorSubject<string | null>(
    this.oauthService.getAccessToken() || null,
  );
  private readonly langSubject = new BehaviorSubject<string>(
    localStorage.getItem(LOCAL_STORAGE_KEY.LANGUAGE) || "en",
  );
  private readonly ownerProfileSubject =
    new BehaviorSubject<OwnerProfile | null>(null);
  private readonly themeSubject = new BehaviorSubject<DathaThemeId>(
    normalizeDathaThemeId(localStorage.getItem(LOCAL_STORAGE_KEY.THEME)),
  );

  readonly authToken$ = this.authTokenSubject.asObservable();
  readonly lang$ = this.langSubject.asObservable();
  readonly theme$ = this.themeSubject.asObservable();
  readonly ownerProfile$ = this.ownerProfileSubject.asObservable();

  constructor(
    private readonly oauthService: OAuthService,
    private readonly authService: AuthenticationService,
    private readonly translate: TranslateService,
  ) {
    const rawTheme = localStorage.getItem(LOCAL_STORAGE_KEY.THEME);
    const theme = normalizeDathaThemeId(rawTheme);
    if (rawTheme !== null && rawTheme !== theme) {
      localStorage.setItem(LOCAL_STORAGE_KEY.THEME, theme);
    }

    this.oauthService.events
      .pipe(
        filter(
          (e: OAuthEvent) =>
            e.type === "token_received" || e.type === "token_refreshed",
        ),
      )
      .subscribe(() => {
        this.authTokenSubject.next(this.oauthService.getAccessToken() || null);
        this.syncProfile();
      });

    this.translate.onLangChange.subscribe(({ lang }) => {
      this.langSubject.next(lang);
    });

    this.syncProfile();
  }

  logout(): void {
    this.authService.logout();
  }

  setLang(lang: string): void {
    this.translate.use(lang);
    localStorage.setItem(LOCAL_STORAGE_KEY.LANGUAGE, lang);
    this.langSubject.next(lang);
  }

  setTheme(theme: DathaThemeId): void {
    localStorage.setItem(LOCAL_STORAGE_KEY.THEME, theme);
    this.themeSubject.next(theme);
  }

  get currentThemeId(): DathaThemeId {
    return this.themeSubject.getValue();
  }

  private syncProfile(): void {
    const claims = this.oauthService.getIdentityClaims() as Record<
      string,
      unknown
    > | null;
    if (!claims) return;
    const name = String(
      claims["name"] ?? claims["given_name"] ?? claims["email"] ?? "",
    );
    const email = String(claims["email"] ?? "");
    const username = String(
      claims["preferred_username"] ?? claims["unique_name"] ?? "",
    );
    this.ownerProfileSubject.next({
      name,
      email,
      username: username || undefined,
    });
  }
}
