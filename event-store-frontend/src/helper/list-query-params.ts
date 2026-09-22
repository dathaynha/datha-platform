import { HttpParams } from "@angular/common/http";
import { ParamMap } from "@angular/router";

/**
 * Canonical order for a multi-value filter, so the URL is stable whatever order
 * the values were picked in.
 *
 * Alphabetical, and that is now the only order there is: the services and sinks
 * these lists filter by used to be hard-coded arrays whose declaration order
 * was the display order, and both are fetched from the data now. A caller that
 * wants a different order would have to get it from somewhere, and there is
 * nowhere left for it to come from.
 */
export function sortFilterValues(values: readonly string[]): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

/** Read repeated or comma-separated query values (`?service=a&service=b`). */
export function readQueryStringArray(map: ParamMap, key: string): string[] {
  const raw = map.getAll(key);
  if (raw.length === 0) {
    return [];
  }

  const values = raw.flatMap((entry) =>
    entry
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean),
  );

  return [...new Set(values)];
}

export function appendQueryStringArray(
  params: HttpParams,
  key: string,
  values: readonly string[],
): HttpParams {
  let next = params;
  for (const value of values) {
    next = next.append(key, value);
  }
  return next;
}

export function parseCommaSeparatedInput(value: string): string[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean),
    ),
  ];
}

export function readOptionalIsoDate(map: ParamMap, key: string): Date | null {
  const raw = map.get(key);
  if (!raw) {
    return null;
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function setRouterQueryArray(
  target: RouterQueryParams,
  key: string,
  values: readonly string[],
): void {
  if (values.length === 0) {
    target[key] = null;
    return;
  }
  target[key] = values.length === 1 ? values[0] : [...values];
}

export function setRouterQueryScalar(
  target: RouterQueryParams,
  key: string,
  value: string | null | undefined,
): void {
  const trimmed = value?.trim();
  target[key] = trimmed ? trimmed : null;
}

export function setRouterQueryIsoDate(
  target: RouterQueryParams,
  key: string,
  value: Date | null,
): void {
  if (!value || Number.isNaN(value.getTime())) {
    target[key] = null;
    return;
  }
  target[key] = value.toISOString();
}

export function setRouterQueryOffset(
  target: RouterQueryParams,
  offset: number,
): void {
  target["offset"] = offset > 0 ? String(offset) : null;
}

export type ListSortOrder = "asc" | "desc";

export function readListSortOrder(map: ParamMap, key = "order"): ListSortOrder {
  const raw = map.get(key);
  return raw === "asc" ? "asc" : "desc";
}

export function setRouterQuerySortOrder(
  target: RouterQueryParams,
  order: ListSortOrder,
  key = "order",
): void {
  target[key] = order === "desc" ? null : order;
}

export function listSortOrderToPrime(sortOrder: ListSortOrder): 1 | -1 {
  return sortOrder === "asc" ? 1 : -1;
}

export function primeSortOrderToList(order: number | undefined): ListSortOrder {
  return order === 1 ? "asc" : "desc";
}

export interface ListFilterChip {
  id: string;
  labelKey: string;
  labelParams: Record<string, string>;
}

export type RouterQueryParams = Record<
  string,
  string | string[] | null | undefined
>;
