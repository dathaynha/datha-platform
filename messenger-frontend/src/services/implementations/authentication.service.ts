import { Injectable } from "@angular/core";
import { Router } from "@angular/router";
import { LOCAL_STORAGE_KEY } from "@constants/index";
import { AuthConfig, OAuthService } from "angular-oauth2-oidc";
import { JwksValidationHandler } from "angular-oauth2-oidc-jwks";
import { environment } from "src/environments/environment";
import { EnvService } from "./config.service";

/** Microsoft Entra sign-in audience; must match gateway token URL + id_token issuer. */
export type EntraLoginPool = "organizations" | "consumers";

/** Stored in `LOCAL_STORAGE_KEY.AUTH_PROVIDER`. */
export enum AuthProvider {
  ENTRA = "entra",
  GOOGLE = "google",
}

@Injectable({
  providedIn: "root",
})
export class AuthenticationService {
  private currentProvider: AuthProvider | null = null;
  private oauthEventHandlersAttached = false;

  constructor(
    private oauthService: OAuthService,
    private router: Router,
    private configService: EnvService,
  ) {
    this.configService.loadEnvs();
  }

  /**
   * Configure OAuth for a specific provider.
   */
  configOAuthForProvider(provider: AuthProvider): void {
    let authConfig: AuthConfig;

    switch (provider) {
      case AuthProvider.ENTRA: {
        const cfg = environment.entraOidc;
        authConfig = {
          issuer: this.getEntraIssuerForStoredPool(),
          clientId: cfg.clientId,
          scope: cfg.scope,
          responseType: cfg.responseType,
          requireHttps: cfg.requireHttps,
          redirectUri: cfg.redirectUri,
          showDebugInformation: !environment.production,
          strictDiscoveryDocumentValidation: false,
          // Entra multitenant discovery returns a tenant-specific issuer in `issuer`, not literally .../consumers|organizations/v2.0.
          skipIssuerCheck: true,
        };
        break;
      }
      case AuthProvider.GOOGLE: {
        authConfig = this.buildGoogleOidcAuthConfig();
        break;
      }
      default: {
        authConfig = this.buildGoogleOidcAuthConfig();
      }
    }

    this.oauthService.configure(authConfig);
    // Align PKCE/nonce storage with localStorage for cross-site IdP redirects (OAuthStorage is already localStorage).
    (
      this.oauthService as unknown as { saveNoncesInLocalStorage: boolean }
    ).saveNoncesInLocalStorage = true;
    this.currentProvider = provider;

    localStorage.setItem(LOCAL_STORAGE_KEY.AUTH_PROVIDER, provider);
  }

  /**
   * Google "Web application" clients require `client_secret` on the token endpoint.
   * Prefer one of: (1) OAuth client type **Single page application** (no secret), or
   * (2) `tokenProxyUrl` → api-gateway injects the secret, or (3) optional `clientSecret` in env
   * (ships in the bundle — dev only).
   */
  private buildGoogleOidcAuthConfig(): AuthConfig {
    const cfg = environment.googleOidc as typeof environment.googleOidc & {
      clientSecret?: string;
      tokenProxyUrl?: string;
    };
    const base: AuthConfig = {
      issuer: cfg.issuer,
      clientId: cfg.clientId,
      scope: cfg.scope,
      responseType: cfg.responseType,
      requireHttps: cfg.requireHttps,
      redirectUri: cfg.redirectUri,
      showDebugInformation: !environment.production,
      strictDiscoveryDocumentValidation: false,
    };
    if (cfg.tokenProxyUrl) {
      return base;
    }
    if (cfg.clientSecret) {
      return { ...base, dummyClientSecret: cfg.clientSecret };
    }
    return base;
  }

  /** After discovery, point token POSTs at the gateway (adds client_secret) instead of Google. */
  private applyGoogleTokenProxyEndpointIfConfigured(): void {
    const cfg = environment.googleOidc as { tokenProxyUrl?: string };
    if (cfg.tokenProxyUrl) {
      this.oauthService.tokenEndpoint = cfg.tokenProxyUrl;
    }
  }

  /** After discovery, point token POSTs at the gateway so it can issue our internal JWT. */
  private applyEntraTokenProxyEndpointIfConfigured(): void {
    const cfg = environment.entraOidc as { tokenProxyUrl?: string };
    if (cfg?.tokenProxyUrl) {
      this.oauthService.tokenEndpoint = cfg.tokenProxyUrl;
    }
  }

  private parseStoredProvider(raw: string | null): AuthProvider | null {
    if (!raw) {
      return null;
    }
    return Object.values(AuthProvider).includes(raw as AuthProvider)
      ? (raw as AuthProvider)
      : null;
  }

  /** Microsoft Entra: pick work/school vs personal account; persists for token proxy + refresh. */
  async loginWithEntra(pool: EntraLoginPool): Promise<void> {
    localStorage.setItem(LOCAL_STORAGE_KEY.ENTRA_LOGIN_POOL, pool);
    await this.loginWithProvider(AuthProvider.ENTRA);
  }

  private getStoredEntraLoginPool(): EntraLoginPool {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY.ENTRA_LOGIN_POOL);
    return raw === "consumers" ? "consumers" : "organizations";
  }

  private getEntraIssuerForStoredPool(): string {
    const pool = this.getStoredEntraLoginPool();
    const cfg = environment.entraOidc as {
      issuer?: string;
      issuerPersonalMicrosoft?: string;
    };
    if (pool === "consumers") {
      return (
        cfg.issuerPersonalMicrosoft ??
        "https://login.microsoftonline.com/consumers/v2.0"
      );
    }
    return cfg.issuer ?? "https://login.microsoftonline.com/organizations/v2.0";
  }

  /**
   * Start OIDC authorization code flow for the given provider.
   */
  async loginWithProvider(provider: AuthProvider): Promise<void> {
    try {
      this.configOAuthForProvider(provider);

      await this.oauthService.loadDiscoveryDocument();
      if (provider === AuthProvider.GOOGLE) {
        this.applyGoogleTokenProxyEndpointIfConfigured();
        // Google only returns a refresh_token when the user sees consent; offline keeps it usable for refresh_grant.
        this.oauthService.initCodeFlow("", {
          access_type: "offline",
          prompt: "consent",
        });
      } else if (provider === AuthProvider.ENTRA) {
        this.applyEntraTokenProxyEndpointIfConfigured();
        this.oauthService.initCodeFlow();
      } else {
        this.oauthService.initCodeFlow();
      }
    } catch (error) {
      console.error(`Error during ${provider} login setup:`, error);
      throw error;
    }
  }

  /**
   * Runs before the app router activates routes. Awaits discovery + code exchange so
   * guards can rely on {@link OAuthService#hasValidAccessToken} after redirect.
   */
  async bootstrapAuth(): Promise<void> {
    try {
      const savedProvider = this.parseStoredProvider(
        localStorage.getItem(LOCAL_STORAGE_KEY.AUTH_PROVIDER),
      );

      if (!savedProvider) {
        return;
      }

      this.configOAuthForProvider(savedProvider);
      this.ensureOAuthClientInfrastructure();

      await this.oauthService.loadDiscoveryDocument();
      if (savedProvider === AuthProvider.GOOGLE) {
        this.applyGoogleTokenProxyEndpointIfConfigured();
      } else if (savedProvider === AuthProvider.ENTRA) {
        this.applyEntraTokenProxyEndpointIfConfigured();
      }
      const isLogin = await this.oauthService.tryLogin();

      if (isLogin) {
        this.recordLoginTimeIfNeeded();
        if (savedProvider === AuthProvider.GOOGLE) {
          if (this.hasUsableRefreshToken()) {
            this.oauthService.setupAutomaticSilentRefresh();
          } else {
            this.oauthService.stopAutomaticRefresh();
          }
        }
        const tokenExp = this.oauthService.getAccessTokenExpiration();
        const now = new Date().getTime();
        if (tokenExp && tokenExp < now) {
          if (this.hasUsableRefreshToken()) {
            await this.refreshToken();
          } else {
            this.logout();
          }
        }
      }
    } catch (error) {
      console.error("Error during OAuth bootstrap", error);
    }
  }

  /** OAuth listeners + PKCE; idempotent. */
  ensureOAuthClientInfrastructure(): void {
    this.oauthService.tokenValidationHandler = new JwksValidationHandler();
    // Google without a refresh_token: the library would POST `refresh_token=null` on silent refresh.
    if (
      this.currentProvider === AuthProvider.GOOGLE &&
      !this.hasUsableRefreshToken()
    ) {
      this.oauthService.stopAutomaticRefresh();
    } else {
      this.oauthService.setupAutomaticSilentRefresh();
    }
    if (!this.oauthEventHandlersAttached) {
      this.setupOAuthEventHandlers();
      this.oauthEventHandlersAttached = true;
    }
  }

  private recordLoginTimeIfNeeded(): void {
    if (!localStorage.getItem(LOCAL_STORAGE_KEY.LOGIN_TIME)) {
      localStorage.setItem(LOCAL_STORAGE_KEY.LOGIN_TIME, Date.now().toString());
      localStorage.removeItem(LOCAL_STORAGE_KEY.SESSION_NUMBER);
    }
  }

  private setupOAuthEventHandlers(): void {
    this.oauthService.events.subscribe((event) => {
      if (event.type === "token_received") {
        this.recordLoginTimeIfNeeded();
        // Google code flow without a refresh token would POST `refresh_token=null` on expiry — disable auto-refresh until re-login with consent.
        if (this.currentProvider === AuthProvider.GOOGLE) {
          if (this.hasUsableRefreshToken()) {
            this.oauthService.setupAutomaticSilentRefresh();
          } else {
            this.oauthService.stopAutomaticRefresh();
          }
        }
      }

      // Both paths mean the session is gone: clear stored auth and return the
      // user to /login rather than leaving them on a dead session.
      if (event.type === "token_error") {
        console.error("Token error:", event);
        this.logout();
      }

      if (event.type === "session_terminated") {
        this.logout();
      }
    });
  }

  /**
   * True when a non-empty refresh token is in OAuth storage (library otherwise POSTs `refresh_token=null`).
   */
  hasUsableRefreshToken(): boolean {
    const t = this.oauthService.getRefreshToken();
    return (
      typeof t === "string" && t.length > 0 && t !== "null" && t !== "undefined"
    );
  }

  async refreshToken(): Promise<void> {
    if (!this.hasUsableRefreshToken()) {
      console.warn(
        "No Google refresh token — sign in again (consent + offline).",
      );
      this.logout();
      return;
    }
    try {
      await this.oauthService.refreshToken();
    } catch (error) {
      console.error("Error refreshing token:", error);
      this.logout();
      throw error;
    }
  }

  private clearAuthData(): void {
    localStorage.removeItem(LOCAL_STORAGE_KEY.LOGIN_TIME);
    localStorage.removeItem(LOCAL_STORAGE_KEY.SESSION_NUMBER);
    localStorage.removeItem(LOCAL_STORAGE_KEY.AUTH_PROVIDER);
    localStorage.removeItem(LOCAL_STORAGE_KEY.ENTRA_LOGIN_POOL);
    this.currentProvider = null;
  }

  logout(): void {
    // Local logout only. Passing true skips the redirect to the IdP's
    // end_session_endpoint, which would end the *provider's* session and sign
    // the user out of every other site relying on it. Entra publishes that
    // endpoint and Google does not, so without this flag the same button
    // behaves differently per provider.
    this.oauthService.logOut(true);
    this.clearAuthData();
    this.router.navigate(["/login"]);
  }

  isAuthenticated(): boolean {
    return this.oauthService.hasValidAccessToken();
  }

  getCurrentProvider(): AuthProvider | null {
    return this.currentProvider;
  }

  /** Provider chosen at login (`currentProvider` or persisted before bootstrap completes). */
  getResolvedAuthProvider(): AuthProvider | null {
    if (this.currentProvider !== null) {
      return this.currentProvider;
    }
    return this.parseStoredProvider(
      localStorage.getItem(LOCAL_STORAGE_KEY.AUTH_PROVIDER),
    );
  }

  getAccessToken(): string {
    return this.oauthService.getAccessToken();
  }

  getUserClaims(): unknown {
    return this.oauthService.getIdentityClaims();
  }
}
