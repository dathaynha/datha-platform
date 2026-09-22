import { ParamMap } from "@angular/router";
import {
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

export interface DlqListFilterState {
  sinks: string[];
  correlationId: string;
  ownerId: string;
  from: Date | null;
  to: Date | null;
  offset: number;
  order: ListSortOrder;
}

export function parseDlqListQuery(map: ParamMap): DlqListFilterState {
  const offsetRaw = map.get("offset");
  const offset = offsetRaw ? Number.parseInt(offsetRaw, 10) : 0;

  return {
    sinks: sortFilterValues(readQueryStringArray(map, "sink")),
    correlationId: map.get("correlation_id") ?? "",
    ownerId: map.get("owner_id") ?? "",
    from: readOptionalIsoDate(map, "from"),
    to: readOptionalIsoDate(map, "to"),
    offset: Number.isFinite(offset) && offset > 0 ? offset : 0,
    order: readListSortOrder(map),
  };
}

export function toDlqListQueryParams(
  state: DlqListFilterState,
): RouterQueryParams {
  const params: RouterQueryParams = {};

  setRouterQueryArray(params, "sink", state.sinks);
  setRouterQueryScalar(params, "correlation_id", state.correlationId);
  setRouterQueryScalar(params, "owner_id", state.ownerId);
  setRouterQueryIsoDate(params, "from", state.from);
  setRouterQueryIsoDate(params, "to", state.to);
  setRouterQueryOffset(params, state.offset);
  setRouterQuerySortOrder(params, state.order);

  return params;
}

export function dlqListHasAdvancedFilters(state: DlqListFilterState): boolean {
  return (
    state.ownerId.trim().length > 0 || state.from != null || state.to != null
  );
}
