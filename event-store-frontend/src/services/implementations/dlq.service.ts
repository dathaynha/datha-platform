import {
  HttpClient,
  HttpContext,
  HttpHeaders,
  HttpParams,
} from "@angular/common/http";
import { Injectable } from "@angular/core";
import { appendQueryStringArray } from "@helper/list-query-params";
import type {
  DlqListParams,
  DlqListResponse,
  DlqRecord,
  DlqReplayResponse,
} from "@models/dlq.model";
import { map, Observable } from "rxjs";
import {
  SKIP_ERROR_DIALOG_HEADER,
  SKIP_GLOBAL_ERROR_DIALOG,
} from "src/interceptors/http-context.tokens";

import { eventStoreGatewayBase } from "./event-store-gateway-base";

@Injectable({ providedIn: "root" })
export class DlqService {
  /**
   * Quiet-errors marker in both forms. The context token works standalone; the
   * header is what survives Module Federation, because hosted by the shell the
   * interceptor that owns the dialog is the shell's and reads its own token
   * object. A replay failure is reported by the page, not by a modal.
   */
  private readonly quiet = new HttpContext().set(
    SKIP_GLOBAL_ERROR_DIALOG,
    true,
  );
  private readonly quietHeaders = new HttpHeaders().set(
    SKIP_ERROR_DIALOG_HEADER,
    "1",
  );

  constructor(private readonly http: HttpClient) {}

  list(params: DlqListParams = {}): Observable<DlqListResponse> {
    let httpParams = new HttpParams();

    if (params.sinks?.length) {
      httpParams = appendQueryStringArray(httpParams, "sink", params.sinks);
    }
    if (params.correlationId) {
      httpParams = httpParams.set("correlation_id", params.correlationId);
    }
    if (params.ownerId) {
      httpParams = httpParams.set("owner_id", params.ownerId);
    }
    if (params.from) {
      httpParams = httpParams.set("from", params.from);
    }
    if (params.to) {
      httpParams = httpParams.set("to", params.to);
    }
    if (params.limit != null) {
      httpParams = httpParams.set("limit", String(params.limit));
    }
    if (params.offset != null) {
      httpParams = httpParams.set("offset", String(params.offset));
    }
    if (params.order) {
      httpParams = httpParams.set("order", params.order);
    }

    return this.http.get<DlqListResponse>(`${eventStoreGatewayBase()}/dlq`, {
      params: httpParams,
    });
  }

  /**
   * Sinks that have actually dead-lettered. Raw, same as the event services.
   *
   * Quiet: a filter that cannot fetch its options degrades to offering none,
   * and a modal over a page that is otherwise working is the wrong report.
   */
  listSinks(): Observable<string[]> {
    return this.http
      .get<{ data: string[] }>(`${eventStoreGatewayBase()}/dlq/sinks`, {
        context: this.quiet,
        headers: this.quietHeaders,
      })
      .pipe(map((res) => res.data));
  }

  getById(id: string): Observable<DlqRecord> {
    return this.http.get<DlqRecord>(
      `${eventStoreGatewayBase()}/dlq/${encodeURIComponent(id)}`,
    );
  }

  replay(id: string): Observable<DlqReplayResponse> {
    return this.http.post<DlqReplayResponse>(
      `${eventStoreGatewayBase()}/dlq/${encodeURIComponent(id)}/replay`,
      null,
      {
        context: this.quiet,
        headers: this.quietHeaders,
      },
    );
  }
}
