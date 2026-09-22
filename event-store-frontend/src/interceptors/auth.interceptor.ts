import {
  HttpErrorResponse,
  HttpEvent,
  HttpHandler,
  HttpInterceptor,
  HttpRequest,
} from "@angular/common/http";
import { LOCAL_STORAGE_KEY } from "@constants/index";
import {
  SKIP_ERROR_DIALOG_HEADER,
  SKIP_GLOBAL_ERROR_DIALOG,
} from "./http-context.tokens";
import { Inject, Injectable, InjectionToken } from "@angular/core";
import { MessageDialogComponent } from "@datha/platform-ui";
import { AuthenticationService } from "@services/implementations/authentication.service";
import { CommonService } from "@services/implementations/common.service";
import { DialogService } from "primeng/dynamicdialog";
import { OAuthService } from "angular-oauth2-oidc";
import { environment } from "src/environments/environment";
import { from, Observable, throwError } from "rxjs";
import { catchError, switchMap, take, timeoutWith } from "rxjs/operators";

export const DEFAULT_TIMEOUT = new InjectionToken<number>("defaultTimeout");

@Injectable()
export class AuthInterceptor implements HttpInterceptor {
  private showPopUpExpired = false;

  constructor(
    private dialog: DialogService,
    private oAuthService: OAuthService,
    private authenticationService: AuthenticationService,
    private commonService: CommonService,
    @Inject(DEFAULT_TIMEOUT) protected defaultTimeout: number,
  ) {}

  intercept(
    request: HttpRequest<unknown>,
    next: HttpHandler,
  ): Observable<HttpEvent<unknown>> {
    request = this.addMicrosoftLoginPoolHeader(request);
    request = this.addAuthHeader(request);

    const timeoutValue = Number(
      request.headers.get("timeout") || this.defaultTimeout,
    );

    // The quiet-errors marker is for this interceptor only, so it is removed
    // before the request leaves the browser: no internal hint travels
    // upstream, and the flag still applies on the error path below.
    const outgoing = request.headers.has(SKIP_ERROR_DIALOG_HEADER)
      ? request.clone({
          headers: request.headers.delete(SKIP_ERROR_DIALOG_HEADER),
        })
      : request;

    return next.handle(outgoing).pipe(
      timeoutWith(
        timeoutValue,
        throwError(
          () =>
            new HttpErrorResponse({
              status: 408,
              statusText: "Request Timeout",
            }),
        ),
      ),
      catchError((error: unknown) =>
        this.handleError(error as HttpErrorResponse, request, next),
      ),
    );
  }

  private handleError(
    error: HttpErrorResponse,
    request: HttpRequest<unknown>,
    next: HttpHandler,
  ): Observable<never> | Observable<HttpEvent<unknown>> {
    if (
      error.status === 401 &&
      this.authenticationService.hasUsableRefreshToken()
    ) {
      const timeoutValue = Number(
        request.headers.get("timeout") || this.defaultTimeout,
      );
      this.commonService.setLoading(true);
      return from(this.authenticationService.refreshToken()).pipe(
        switchMap(() => {
          this.commonService.setLoading(false);
          request = this.addMicrosoftLoginPoolHeader(request);
          request = this.addAuthHeader(request);
          return next.handle(request).pipe(
            timeoutWith(
              timeoutValue,
              throwError(
                () =>
                  new HttpErrorResponse({
                    status: 408,
                    statusText: "Request Timeout",
                  }),
              ),
            ),
            catchError((err: unknown) =>
              this.handleResponseError(err as HttpErrorResponse, request),
            ),
          );
        }),
        catchError((refreshError: HttpErrorResponse) => {
          this.commonService.setLoading(false);
          if (refreshError.status !== 401) {
            return this.handleResponseError(refreshError, request);
          } else {
            return throwError(() => refreshError);
          }
        }),
      );
    }

    return this.handleResponseError(error, request);
  }

  private handleResponseError(
    error: HttpErrorResponse,
    request: HttpRequest<unknown>,
  ): Observable<never> {
    const errorMessages: Record<number, string> = {
      400: "BAD_REQUEST",
      401: "UNAUTHORIZED",
      403: "FORBIDDEN",
      404: "NOT_FOUND",
      500: "INTERNAL_SERVER_ERROR",
      502: "BAD_GATEWAY",
      503: "SERVICE_UNAVAILABLE",
      504: "GATEWAY_TIMEOUT",
      0: "CONNECTION_LOST",
    };

    const errorKey = errorMessages[error.status] ?? "GENERAL_ERROR";
    const serverBodyHtml = this.buildServerDetailHtml(error.error);
    const titleFromServer =
      typeof error.error === "object" &&
      error.error !== null &&
      typeof (error.error as { title?: unknown }).title === "string"
        ? String((error.error as { title: string }).title).trim()
        : "";

    // The header is what this remote can set when hosted by the shell; the
    // context token only works within one bundle. See SKIP_ERROR_DIALOG_HEADER.
    const skipDialog =
      request.context.get(SKIP_GLOBAL_ERROR_DIALOG) ||
      request.headers.has(SKIP_ERROR_DIALOG_HEADER);
    if (!skipDialog && !this.showPopUpExpired) {
      this.showPopUpMessage(titleFromServer, serverBodyHtml, errorKey);
    }

    return throwError(() => error);
  }

  /** Prefer API/OAuth fields over i18n when present; escape for `[innerHTML]`. */
  private buildServerDetailHtml(errorBody: unknown): string | null {
    if (errorBody == null) {
      return null;
    }
    if (typeof errorBody === "string") {
      const t = errorBody.trim();
      return t ? `<b>${this.escapeHtml(t)}</b>` : null;
    }
    if (typeof errorBody !== "object") {
      return null;
    }
    const e = errorBody as Record<string, unknown>;

    if (typeof e["detail"] === "string") {
      const t = e["detail"].trim();
      return t ? `<b>${this.escapeHtml(t)}</b>` : null;
    }
    if (Array.isArray(e["detail"]) && e["detail"].length > 0) {
      const parts = e["detail"].map((item) =>
        typeof item === "object" && item !== null && "msg" in item
          ? String((item as { msg: unknown }).msg)
          : JSON.stringify(item),
      );
      const joined = parts.join(" ").trim();
      return joined ? `<b>${this.escapeHtml(joined)}</b>` : null;
    }
    if (typeof e["error_description"] === "string") {
      const t = e["error_description"].trim();
      return t ? `<b>${this.escapeHtml(t)}</b>` : null;
    }
    if (
      typeof e["error"] === "string" &&
      typeof e["error_description"] !== "string"
    ) {
      const t = String(e["error"]).trim();
      return t ? `<b>${this.escapeHtml(t)}</b>` : null;
    }
    if (typeof e["message"] === "string") {
      const t = e["message"].trim();
      return t ? `<b>${this.escapeHtml(t)}</b>` : null;
    }
    return null;
  }

  private escapeHtml(s: string): string {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /**
   * Opens the error dialog. When the error came from the API (titleFromServer / serverBodyHtml),
   * raw strings are passed directly. For generic HTTP errors the dialog receives i18n keys so
   * the TranslatePipe keeps the content in sync with the active language.
   */
  private showPopUpMessage(
    titleFromServer: string,
    serverBodyHtml: string | null,
    errorKey: string,
  ): void {
    this.showPopUpExpired = true;
    const ref = this.dialog.open(MessageDialogComponent, {
      header: titleFromServer || undefined,
      data: {
        titleKey: titleFromServer ? undefined : `${errorKey}.title`,
        messageKey: serverBodyHtml ? undefined : `${errorKey}.message`,
        message: serverBodyHtml ?? undefined,
      },
      closable: true,
      modal: true,
      duplicate: true,
      width: "min(480px, 92vw)",
    });

    if (ref) {
      ref.onClose.pipe(take(1)).subscribe(() => {
        this.showPopUpExpired = false;
      });
    }
  }

  private isOAuthTokenProxy(url: string): boolean {
    const googleProxy = (environment.googleOidc as { tokenProxyUrl?: string })
      .tokenProxyUrl;
    if (googleProxy && url.startsWith(googleProxy)) {
      return true;
    }
    const entraProxy = (environment.entraOidc as { tokenProxyUrl?: string })
      ?.tokenProxyUrl;
    if (entraProxy && url.startsWith(entraProxy)) {
      return true;
    }
    return false;
  }

  /**
   * Do not send the app access token to IdP / discovery / token host URLs — wrong audience, triggers
   * CORS preflight failures, and is not what those endpoints expect.
   */
  private shouldAttachApiBearer(url: string): boolean {
    if (this.isOAuthTokenProxy(url)) {
      return false;
    }
    const skipPrefixes: string[] = [
      ...(environment.oauth?.ignoreUrls?.urls ?? []),
    ];
    const iam = environment.iamOidc?.issuer;
    if (iam) {
      skipPrefixes.push(iam);
    }
    const entra = environment.entraOidc?.issuer;
    if (entra && !skipPrefixes.includes(entra)) {
      skipPrefixes.push(entra);
    }
    const entraPersonal = (
      environment.entraOidc as { issuerPersonalMicrosoft?: string }
    ).issuerPersonalMicrosoft;
    if (entraPersonal && !skipPrefixes.includes(entraPersonal)) {
      skipPrefixes.push(entraPersonal);
    }
    return !skipPrefixes.some((prefix) => url.startsWith(prefix));
  }

  /** Matches Entra issuer used for code exchange (`organizations` vs `consumers`) to api-gateway. */
  private addMicrosoftLoginPoolHeader(
    request: HttpRequest<unknown>,
  ): HttpRequest<unknown> {
    const entraProxy = (
      environment.entraOidc as { tokenProxyUrl?: string } | undefined
    )?.tokenProxyUrl;
    if (!entraProxy) {
      return request;
    }
    const base = entraProxy.split("?")[0];
    if (!request.url.startsWith(base)) {
      return request;
    }
    const pool = localStorage.getItem(LOCAL_STORAGE_KEY.ENTRA_LOGIN_POOL);
    if (pool !== "organizations" && pool !== "consumers") {
      return request;
    }
    return request.clone({
      setHeaders: { "X-Microsoft-Login-Pool": pool },
    });
  }

  /**
   * Attaches the API bearer, and owns the decision of when not to.
   *
   * The rule lives here rather than at the call sites because there are two of
   * them: the initial request and the 401 refresh-retry. Guarding only the
   * first put the token on retries to IdP and token-proxy URLs it is not meant
   * for, which is a wrong audience and a CORS preflight failure.
   */
  private addAuthHeader(request: HttpRequest<unknown>): HttpRequest<unknown> {
    if (!this.shouldAttachApiBearer(request.url)) {
      return request;
    }
    const token = this.oAuthService.getAccessToken();
    if (token) {
      return request.clone({
        setHeaders: {
          Authorization: `Bearer ${token}`,
        },
      });
    }
    return request;
  }
}
