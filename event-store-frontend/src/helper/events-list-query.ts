import { ParamMap } from "@angular/router";
import {
  parseCommaSeparatedInput,
  readOptionalIsoDate,
  readQueryStringArray,
  readListSortOrder,
  RouterQueryParams,
  setRouterQueryArray,
  setRouterQueryIsoDate,
  setRouterQueryOffset,
  setRouterQueryScalar,
  setRouterQuerySortOrder,
  sortFilterValues,
  type ListSortOrder,
} from "@helper/list-query-params";

/**
 * `?payload.origin=messenger` — equality on a payload field.
 *
 * A map rather than a single pair because a deep link may carry several and
 * the service ANDs them. The page's own inputs edit one key at a time.
 */
export type PayloadFilters = Record<string, string>;

/** Payload keys are identifiers; anything else the service would reject. */
const PAYLOAD_KEY = /^[A-Za-z0-9_]{1,64}$/;
const PAYLOAD_PREFIX = "payload.";

export function readPayloadFilters(map: ParamMap): PayloadFilters {
  const out: PayloadFilters = {};
  for (const raw of map.keys) {
    if (!raw.startsWith(PAYLOAD_PREFIX)) continue;
    const key = raw.slice(PAYLOAD_PREFIX.length);
    const value = map.get(raw) ?? "";
    if (PAYLOAD_KEY.test(key) && value) {
      out[key] = value;
    }
  }
  return out;
}

export interface EventsListFilterState {
  services: string[];
  payload: PayloadFilters;
  types: string[];
  correlationId: string;
  entityId: string;
  ownerId: string;
  from: Date | null;
  to: Date | null;
  offset: number;
  order: ListSortOrder;
}

export function parseEventsListQuery(map: ParamMap): EventsListFilterState {
  const offsetRaw = map.get("offset");
  const offset = offsetRaw ? Number.parseInt(offsetRaw, 10) : 0;

  return {
    services: sortFilterValues(readQueryStringArray(map, "service")),
    payload: readPayloadFilters(map),
    types: sortFilterValues(readQueryStringArray(map, "type")),
    correlationId: map.get("correlation_id") ?? "",
    entityId: map.get("entity_id") ?? "",
    ownerId: map.get("owner_id") ?? "",
    from: readOptionalIsoDate(map, "from"),
    to: readOptionalIsoDate(map, "to"),
    offset: Number.isFinite(offset) && offset > 0 ? offset : 0,
    order: readListSortOrder(map),
  };
}

export function toEventsListQueryParams(
  state: EventsListFilterState,
): RouterQueryParams {
  const params: RouterQueryParams = {};

  setRouterQueryArray(params, "service", state.services);
  // Sorted, so the same filter always produces the same URL.
  for (const key of Object.keys(state.payload).sort()) {
    params[`${PAYLOAD_PREFIX}${key}`] = state.payload[key];
  }
  setRouterQueryArray(params, "type", state.types);
  setRouterQueryScalar(params, "correlation_id", state.correlationId);
  setRouterQueryScalar(params, "entity_id", state.entityId);
  setRouterQueryScalar(params, "owner_id", state.ownerId);
  setRouterQueryIsoDate(params, "from", state.from);
  setRouterQueryIsoDate(params, "to", state.to);
  setRouterQueryOffset(params, state.offset);
  setRouterQuerySortOrder(params, state.order);

  return params;
}

export function typesFromInput(typeInput: string): string[] {
  return sortFilterValues(parseCommaSeparatedInput(typeInput));
}

export function typeInputFromTypes(types: readonly string[]): string {
  return sortFilterValues(types).join(", ");
}

export function eventsListHasAdvancedFilters(
  state: EventsListFilterState,
): boolean {
  return (
    Object.keys(state.payload).length > 0 ||
    state.types.length > 0 ||
    state.entityId.trim().length > 0 ||
    state.ownerId.trim().length > 0 ||
    state.from != null ||
    state.to != null
  );
}
