import {
  HttpClient,
  HttpContext,
  HttpHeaders,
  HttpParams,
} from "@angular/common/http";
import { Injectable } from "@angular/core";
import { appendQueryStringArray } from "@helper/list-query-params";
import type {
  EventListParams,
  EventListResponse,
  PlatformEvent,
} from "@models/event.model";
import { map, Observable } from "rxjs";

import {
  SKIP_ERROR_DIALOG_HEADER,
  SKIP_GLOBAL_ERROR_DIALOG,
} from "src/interceptors/http-context.tokens";

import { eventStoreGatewayBase } from "./event-store-gateway-base";

@Injectable({ providedIn: "root" })
export class EventsService {
  /**
   * Quiet-errors marker in both forms, as `DlqService` carries it: the context
   * token works standalone, the header is what survives Module Federation.
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

  list(params: EventListParams = {}): Observable<EventListResponse> {
    let httpParams = new HttpParams();

    if (params.types?.length) {
      httpParams = appendQueryStringArray(httpParams, "type", params.types);
    }
    if (params.services?.length) {
      httpParams = appendQueryStringArray(
        httpParams,
        "service",
        params.services,
      );
    }
    if (params.entityId) {
      httpParams = httpParams.set("entity_id", params.entityId);
    }
    if (params.ownerId) {
      httpParams = httpParams.set("owner_id", params.ownerId);
    }
    if (params.correlationId) {
      httpParams = httpParams.set("correlation_id", params.correlationId);
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
    for (const [key, value] of Object.entries(params.payload ?? {})) {
      httpParams = httpParams.set(`payload.${key}`, value);
    }
    if (params.after) {
      httpParams = httpParams.set("after", params.after);
    } else if (params.offset != null) {
      httpParams = httpParams.set("offset", String(params.offset));
    }
    if (params.order) {
      httpParams = httpParams.set("order", params.order);
    }

    return this.http.get<EventListResponse>(
      `${eventStoreGatewayBase()}/events`,
      {
        params: httpParams,
      },
    );
  }

  /**
   * Services that have actually published an event.
   *
   * Raw identifiers, deliberately untranslated: these name infrastructure, and
   * the reason to filter by one is to match it against a log line. They used to
   * be a hard-coded constant with translated labels, which had drifted to the
   * point where 78% of events could not be filtered at all.
   *
   * Quiet: the page degrades to offering no service filter, and a modal over a
   * list that loaded fine is the wrong way to report that.
   */
  listServices(): Observable<string[]> {
    return this.http
      .get<{ data: string[] }>(`${eventStoreGatewayBase()}/events/services`, {
        context: this.quiet,
        headers: this.quietHeaders,
      })
      .pipe(map((res) => res.data));
  }

  /** Distinct event types, for the type filter's menu. */
  listTypes(): Observable<string[]> {
    return this.http
      .get<{ data: string[] }>(`${eventStoreGatewayBase()}/events/types`, {
        context: this.quiet,
        headers: this.quietHeaders,
      })
      .pipe(map((res) => res.data));
  }

  /** Payload field names seen recently, for the filter's field menu. */
  listPayloadKeys(): Observable<string[]> {
    return this.http
      .get<{ data: string[] }>(
        `${eventStoreGatewayBase()}/events/payload-keys`,
        {
          context: this.quiet,
          headers: this.quietHeaders,
        },
      )
      .pipe(map((res) => res.data));
  }

  /** Values seen for one payload field. Suggestions, not a closed set. */
  listPayloadValues(key: string): Observable<string[]> {
    return this.http
      .get<{ data: string[] }>(
        `${eventStoreGatewayBase()}/events/payload-values`,
        {
          params: new HttpParams().set("key", key),
          context: this.quiet,
          headers: this.quietHeaders,
        },
      )
      .pipe(map((res) => res.data));
  }

  getById(id: string): Observable<PlatformEvent> {
    return this.http.get<PlatformEvent>(
      `${eventStoreGatewayBase()}/events/${encodeURIComponent(id)}`,
    );
  }
}
