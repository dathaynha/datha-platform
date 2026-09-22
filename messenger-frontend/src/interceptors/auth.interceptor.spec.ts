import {
  HttpErrorResponse,
  HttpHandler,
  HttpHeaders,
  HttpRequest,
} from "@angular/common/http";
import { HttpClientTestingModule } from "@angular/common/http/testing";
import { TestBed, fakeAsync, tick } from "@angular/core/testing";
import { OAuthModule, OAuthService } from "angular-oauth2-oidc";
import { DialogService } from "primeng/dynamicdialog";
import { TranslateService } from "@ngx-translate/core";
import { AuthenticationService } from "@services/implementations/authentication.service";
import { CommonService } from "@services/implementations/common.service";

import { EMPTY, throwError } from "rxjs";
import { environment } from "src/environments/environment";

import { AuthInterceptor, DEFAULT_TIMEOUT } from "./auth.interceptor";
import { SKIP_ERROR_DIALOG_HEADER } from "./http-context.tokens";

const QUIET_SPEC_URL = `${environment.gateway.baseUrl}/conversations`;

describe("AuthInterceptor", () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [OAuthModule.forRoot(), HttpClientTestingModule],
      providers: [
        AuthInterceptor,
        { provide: DEFAULT_TIMEOUT, useValue: 180000 },
        { provide: DialogService, useValue: { open: () => null } },
        {
          provide: TranslateService,
          useValue: {
            instant: () => ({ title: "t", message: "m" }),
          },
        },
        { provide: CommonService, useValue: { setLoading: () => {} } },
        {
          provide: AuthenticationService,
          useValue: {
            hasUsableRefreshToken: () => true,
            refreshToken: () => Promise.resolve(),
          },
        },
      ],
    });
    TestBed.inject(OAuthService);
  });

  it("should be created", () => {
    const interceptor: AuthInterceptor = TestBed.inject(AuthInterceptor);
    expect(interceptor).toBeTruthy();
  });

  /**
   * The 401 retry re-attaches the bearer, so the "never send it to an IdP or
   * token proxy" rule has to hold on that path too — it did not, and only the
   * first attach was guarded.
   */
  describe("api bearer targeting", () => {
    function intercepted(url: string): HttpRequest<unknown> {
      const interceptor = TestBed.inject(AuthInterceptor);
      const oauth = TestBed.inject(OAuthService);
      spyOn(oauth, "getAccessToken").and.returnValue("app-access-token");

      let seen: HttpRequest<unknown> | null = null;
      const next: HttpHandler = {
        handle: (req: HttpRequest<unknown>) => {
          seen = req;
          return EMPTY;
        },
      };
      interceptor.intercept(new HttpRequest("GET", url), next).subscribe();
      return seen as unknown as HttpRequest<unknown>;
    }

    it("attaches the bearer to gateway API calls", () => {
      const req = intercepted("http://localhost:8080/api/messenger/health");
      expect(req.headers.get("Authorization")).toBe("Bearer app-access-token");
    });

    it("never attaches it to the OAuth token proxy", () => {
      const req = intercepted(environment.googleOidc.tokenProxyUrl as string);
      expect(req.headers.get("Authorization")).toBeNull();
    });

    it("never attaches it to an identity provider", () => {
      const req = intercepted("https://accounts.google.com/o/oauth2/v2/auth");
      expect(req.headers.get("Authorization")).toBeNull();
    });

    it("does not attach the bearer when the 401 retry hits a token proxy", fakeAsync(() => {
      const interceptor = TestBed.inject(AuthInterceptor);
      const oauth = TestBed.inject(OAuthService);
      spyOn(oauth, "getAccessToken").and.returnValue("app-access-token");

      const attempts: HttpRequest<unknown>[] = [];
      const next: HttpHandler = {
        handle: (req: HttpRequest<unknown>) => {
          attempts.push(req);
          return attempts.length === 1
            ? throwError(() => new HttpErrorResponse({ status: 401 }))
            : EMPTY;
        },
      };

      interceptor
        .intercept(
          new HttpRequest(
            "POST",
            environment.googleOidc.tokenProxyUrl as string,
            {},
          ),
          next,
        )
        .subscribe({ error: () => undefined });

      // The refresh is a promise, so the retry only fires after the microtask queue drains.
      tick();

      // The retry is what regressed: it re-attaches the bearer, so it must obey
      // the same targeting rule as the first attempt.
      expect(attempts.length).toBe(2);
      expect(attempts[1].headers.get("Authorization")).toBeNull();
    }));
  });

  /**
   * A remote cannot use the context token when the shell hosts it: it bundles
   * its own copy of the token file, so the object identity differs from the one
   * the shell's interceptor reads and the opt-out is silently ignored. The
   * header carries the same intent as a value, and must not travel upstream.
   */
  describe("quiet-errors header (crosses the federation boundary)", () => {
    function interceptOnce(headers: Record<string, string>) {
      const interceptor = TestBed.inject(AuthInterceptor);
      const dialog = TestBed.inject(DialogService);
      const opened: unknown[] = [];
      spyOn(dialog, "open").and.callFake((...args: unknown[]) => {
        opened.push(args);
        return null as never;
      });

      const seen: HttpRequest<unknown>[] = [];
      const next: HttpHandler = {
        handle: (req) => {
          seen.push(req);
          return throwError(
            () => new HttpErrorResponse({ status: 500, url: req.url }),
          );
        },
      };

      const request = new HttpRequest("GET", QUIET_SPEC_URL, {
        headers: new HttpHeaders(headers),
      });
      interceptor
        .intercept(request, next)
        .subscribe({ error: () => undefined });

      return { opened, seen };
    }

    it("suppresses the global dialog when the header is present", () => {
      const { opened } = interceptOnce({ [SKIP_ERROR_DIALOG_HEADER]: "1" });
      expect(opened.length).toBe(0);
    });

    it("still opens the dialog without the header", () => {
      const { opened } = interceptOnce({});
      expect(opened.length).toBe(1);
    });

    it("strips the header before the request is sent", () => {
      const { seen } = interceptOnce({ [SKIP_ERROR_DIALOG_HEADER]: "1" });
      expect(seen.length).toBe(1);
      expect(seen[0].headers.has(SKIP_ERROR_DIALOG_HEADER)).toBeFalse();
    });
  });
});
