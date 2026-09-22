import { Injectable } from "@angular/core";
import {
  HttpEvent,
  HttpHandler,
  HttpInterceptor,
  HttpRequest,
} from "@angular/common/http";
import { Observable } from "rxjs";
import { TranslateService } from "@ngx-translate/core";
import { environment } from "src/environments/environment";

/** Skip `culture` query param for OAuth hosts and file/binary API calls (prefix match). */
function shouldSkipCultureQueryParam(url: string): boolean {
  const oauthPrefixes: string[] = environment.oauth?.ignoreUrls?.urls ?? [];
  const filesBase = environment.gateway?.filesBaseUrl?.replace(/\/$/, "") ?? "";
  const prefixes = filesBase ? [...oauthPrefixes, filesBase] : oauthPrefixes;
  return prefixes.some((prefix) => url.startsWith(prefix));
}

@Injectable()
export class TranslateInterceptor implements HttpInterceptor {
  constructor(private translate: TranslateService) {}

  intercept(
    req: HttpRequest<unknown>,
    next: HttpHandler,
  ): Observable<HttpEvent<unknown>> {
    const lang =
      this.translate.currentLang || this.translate.getDefaultLang() || "en";

    const localeMap: { [key: string]: string } = environment.localeMap;

    const acceptLanguage = localeMap[lang] ?? "en-US";

    const headers = { "Accept-Language": acceptLanguage };

    if (shouldSkipCultureQueryParam(req.url)) {
      return next.handle(req.clone({ setHeaders: headers }));
    }

    return next.handle(
      req.clone({
        setHeaders: headers,
        setParams: {
          culture: acceptLanguage,
        },
      }),
    );
  }
}
