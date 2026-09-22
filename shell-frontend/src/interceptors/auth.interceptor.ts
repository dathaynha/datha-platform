import {
  HttpErrorResponse,
  HttpEvent,
  HttpHandler,
  HttpInterceptor,
  HttpRequest,
} from "@angular/common/http";
import { Inject, Injectable, InjectionToken } from "@angular/core";
import {
  SKIP_ERROR_DIALOG_HEADER,
  SKIP_GLOBAL_ERROR_DIALOG,
} from "./http-context.tokens";
import { AuthenticationService } from "@services/implementations/authentication.service";
import { CommonService } from "@services/implementations/common.service";
import { DialogService } from "primeng/dynamicdialog";
import { OAuthService } from "angular-oauth2-oidc";
import { environment } from "src/environments/environment";
import { from, Observable, throwError } from "rxjs";
import { catchError, switchMap, take } from "rxjs/operators";
import { MessageDialogComponent } from "@datha/platform-ui";

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
    // The quiet-errors marker is for this interceptor only, so it is read here
    // and removed before the request leaves the browser: no internal hint is
    // sent upstream, and the flag still applies on the error path below.
    const quiet = request.headers.has(SKIP_ERROR_DIALOG_HEADER);
    const outgoing = quiet
      ? request.clone({
          headers: request.headers.delete(SKIP_ERROR_DIALOG_HEADER),
        })
      : request;
    return next
      .handle(outgoing)
      .pipe(
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
      this.commonService.setLoading(true);
      return from(this.authenticationService.refreshToken()).pipe(
        switchMap(() => {
          this.commonService.setLoading(false);
          request = this.addMicrosoftLoginPoolHeader(request);
          request = this.addAuthHeader(request);
          return next
            .handle(request)
            .pipe(
              catchError((err: unknown) =>
                this.handleResponseError(err as HttpErrorResponse, request),
              ),
            );
        }),
        catchError((refreshError: HttpErrorResponse) => {
          this.commonService.setLoading(false);
          return this.handleResponseError(refreshError, request);
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

    // The header is what a federated remote can set; the context token only
    // works within one bundle. See SKIP_ERROR_DIALOG_HEADER.
    const skipDialog =
      request.context.get(SKIP_GLOBAL_ERROR_DIALOG) ||
      request.headers.has(SKIP_ERROR_DIALOG_HEADER);
    if (!skipDialog && !this.showPopUpExpired) {
      this.showPopUpMessage(errorKey);
    }
    return throwError(() => error);
  }

  /**
   * Passes i18n keys to the dialog so the TranslatePipe keeps content in sync
   * with whichever language is active — no translate.instant() timing issues.
   */
  private showPopUpMessage(errorKey: string): void {
    this.showPopUpExpired = true;
    const ref = this.dialog.open(MessageDialogComponent, {
      data: {
        titleKey: `${errorKey}.title`,
        messageKey: `${errorKey}.message`,
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

  private shouldAttachApiBearer(url: string): boolean {
    const googleProxy = (environment.googleOidc as { tokenProxyUrl?: string })
      .tokenProxyUrl;
    if (googleProxy && url.startsWith(googleProxy)) return false;
    const entraProxy = (environment.entraOidc as { tokenProxyUrl?: string })
      .tokenProxyUrl;
    if (entraProxy && url.startsWith(entraProxy)) return false;

    const skipPrefixes: string[] = [
      ...(environment.oauth?.ignoreUrls?.urls ?? []),
    ];
    return !skipPrefixes.some((prefix) => url.startsWith(prefix));
  }

  private addMicrosoftLoginPoolHeader(
    request: HttpRequest<unknown>,
  ): HttpRequest<unknown> {
    const entraProxy = (
      environment.entraOidc as { tokenProxyUrl?: string } | undefined
    )?.tokenProxyUrl;
    if (!entraProxy) return request;
    const base = entraProxy.split("?")[0];
    if (!request.url.startsWith(base)) return request;
    const pool = localStorage.getItem("entraLoginPool");
    if (pool !== "organizations" && pool !== "consumers") return request;
    return request.clone({ setHeaders: { "X-Microsoft-Login-Pool": pool } });
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
        setHeaders: { Authorization: `Bearer ${token}` },
      });
    }
    return request;
  }
}
