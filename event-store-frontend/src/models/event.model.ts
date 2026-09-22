export interface PlatformEvent {
  id: string;
  type: string;
  service: string;
  entityId: string | null;
  ownerId: string | null;
  correlationId: string | null;
  timestamp: string;
  payload: unknown;
}

export interface EventListParams {
  types?: string[];
  services?: string[];
  entityId?: string;
  ownerId?: string;
  correlationId?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
  order?: "asc" | "desc";
  /** Opaque keyset cursor; when set the service ignores `offset`. */
  after?: string;
  /** Equality filters on payload fields, sent as `?payload.<key>=<value>`. */
  payload?: Record<string, string>;
}

export interface EventListResponse {
  data: PlatformEvent[];
  total: number;
  /**
   * True when `total` is the service's ceiling rather than the real count, so
   * the UI shows "10,000+". An exact `COUNT(*)` reads every matching row; the
   * service counts a capped subquery instead and says when it hit the cap.
   * Optional so a frontend deployed ahead of the service still renders.
   */
  totalCapped?: boolean;
  /**
   * Feed back as `after` to continue past the count cap. Null on the last page.
   *
   * The list pages by offset while the total is exact, because that is what
   * numbered pages need. Past the cap an `OFFSET` of 10,000 would read and
   * discard 10,000 rows — the cost the cap exists to avoid — so the list
   * follows this instead.
   */
  nextCursor?: string | null;
}
