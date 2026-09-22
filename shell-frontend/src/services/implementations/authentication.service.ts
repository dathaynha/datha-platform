import { Injectable } from "@angular/core";
import { Router } from "@angular/router";
import { LOCAL_STORAGE_KEY } from "@constants/index";
import { AuthConfig, OAuthService } from "angular-oauth2-oidc";
import { JwksValidationHandler } from "angular-oauth2-oidc-jwks";
import { environment } from "src/environments/environment";
import { EnvService } from "./config.service";

export type EntraLoginPool = "organizations" | "consumers";

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
          skipIssuerCheck: true,
        };
        break;
      }
      case AuthProvider.GOOGLE:
      default: {
        authConfig = this.buildGoogleOidcAuthConfig();
      }
    }

    this.oauthService.configure(authConfig);
    (
      this.oauthService as unknown as { saveNoncesInLocalStorage: boolean }
    ).saveNoncesInLocalStorage = true;
    this.currentProvider = provider;
    localStorage.setItem(LOCAL_STORAGE_KEY.AUTH_PROVIDER, provider);
  }

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
    if (cfg.tokenProxyUrl || cfg.clientSecret) {
      return base;
    }
    return base;
  }

  private applyGoogleTokenProxyEndpointIfConfigured(): void {
    const cfg = environment.googleOidc as { tokenProxyUrl?: string };
    if (cfg.tokenProxyUrl) {
      this.oauthService.tokenEndpoint = cfg.tokenProxyUrl;
    }
  }

  private applyEntraTokenProxyEndpointIfConfigured(): void {
    const cfg = environment.entraOidc as { tokenProxyUrl?: string };
    if (cfg?.tokenProxyUrl) {
      this.oauthService.tokenEndpoint = cfg.tokenProxyUrl;
    }
  }

  private parseStoredProvider(raw: string | null): AuthProvider | null {
    if (!raw) return null;
    return Object.values(AuthProvider).includes(raw as AuthProvider)
      ? (raw as AuthProvider)
      : null;
  }

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

  async loginWithProvider(provider: AuthProvider): Promise<void> {
    try {
      this.configOAuthForProvider(provider);
      await this.oauthService.loadDiscoveryDocument();
      if (provider === AuthProvider.GOOGLE) {
        this.applyGoogleTokenProxyEndpointIfConfigured();
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

  async bootstrapAuth(): Promise<void> {
    try {
      const savedProvider = this.parseStoredProvider(
        localStorage.getItem(LOCAL_STORAGE_KEY.AUTH_PROVIDER),
      );
      if (!savedProvider) return;

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
        if (
          savedProvider === AuthProvider.GOOGLE &&
          this.hasUsableRefreshToken()
        ) {
          this.oauthService.setupAutomaticSilentRefresh();
        }
      }
    } catch (error) {
      console.error("Error during OAuth bootstrap", error);
    }
  }

  ensureOAuthClientInfrastructure(): void {
    this.oauthService.tokenValidationHandler = new JwksValidationHandler();
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
        if (
          this.currentProvider === AuthProvider.GOOGLE &&
          this.hasUsableRefreshToken()
        ) {
          this.oauthService.setupAutomaticSilentRefresh();
        }
      }
      // A token_error means the session is gone: clear stored auth and return
      // the user to /login rather than leaving them on a dead session.
      if (event.type === "token_error") {
        console.error("Token error:", event);
        this.logout();
      }
    });
  }

  hasUsableRefreshToken(): boolean {
    const t = this.oauthService.getRefreshToken();
    return (
      typeof t === "string" && t.length > 0 && t !== "null" && t !== "undefined"
    );
  }

  async refreshToken(): Promise<void> {
    if (!this.hasUsableRefreshToken()) {
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

  logout(): void {
    // Local logout only. Passing true skips the redirect to the IdP's
    // end_session_endpoint, which would end the *provider's* session and sign
    // the user out of every other site relying on it. Entra publishes that
    // endpoint and Google does not, so without this flag the same button
    // behaves differently per provider.
    this.oauthService.logOut(true);
    localStorage.removeItem(LOCAL_STORAGE_KEY.LOGIN_TIME);
    localStorage.removeItem(LOCAL_STORAGE_KEY.SESSION_NUMBER);
    localStorage.removeItem(LOCAL_STORAGE_KEY.AUTH_PROVIDER);
    localStorage.removeItem(LOCAL_STORAGE_KEY.ENTRA_LOGIN_POOL);
    this.currentProvider = null;
    void this.router.navigate(["/login"]);
  }

  isAuthenticated(): boolean {
    return this.oauthService.hasValidAccessToken();
  }

  getResolvedAuthProvider(): AuthProvider | null {
    if (this.currentProvider !== null) return this.currentProvider;
    return this.parseStoredProvider(
      localStorage.getItem(LOCAL_STORAGE_KEY.AUTH_PROVIDER),
    );
  }

  getAccessToken(): string {
    return this.oauthService.getAccessToken();
  }
}
