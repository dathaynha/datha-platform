import type { Page, Route } from "@playwright/test";

/**
 * Gateway stubs for the event-store routes (`/api/event-store/…`), plus a
 * recorder so specs can assert on the *request* (filters, paging, order), not
 * only on the DOM. No backend is required or contacted.
 *
 * Registration order matters: Playwright gives the last matching handler
 * priority, so the catch-all tripwire goes first and the dispatcher (which may
 * `route.fallback()` back into it) second.
 */

export interface EventFixture {
  id: string;
  type: string;
  service: string;
  entityId: string | null;
  ownerId: string | null;
  correlationId: string | null;
  timestamp: string;
  payload: unknown;
}

export interface DlqFixture {
  id: string;
  subject: string;
  sink: string;
  originalSubject: string;
  ownerId: string | null;
  correlationId: string | null;
  lastError: string;
  failedAt: string;
  payload: unknown;
  envelope: unknown;
  ingestedAt: string;
  replayedAt: string | null;
  jetstreamStream: string;
  jetstreamSequence: string;
}

/** Distinct values, ascending — what the service's own endpoints return. */
function distinct(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

/** Failure injection for one endpoint: a status, optionally with a body. */
export interface ErrorResponse {
  status: number;
  body?: unknown;
}

export interface EventStoreMockOptions {
  events?: EventFixture[];
  dlq?: DlqFixture[];
  /** Fail `GET /events` with this status instead of listing. */
  eventsListError?: ErrorResponse;
  /** Fail `GET /dlq` with this status instead of listing. */
  dlqListError?: ErrorResponse;
  /** Fail `GET /events/:id` — detail only, the list still succeeds. */
  eventDetailError?: ErrorResponse;
  /** Fail `GET /dlq/:id` — detail only, the list still succeeds. */
  dlqDetailError?: ErrorResponse;
  /** Fail `POST /dlq/:id/replay`; omit for the success path. */
  replayError?: ErrorResponse;
  /** Fail `GET /events/services` — the filter must still render and work. */
  serviceOptionsError?: ErrorResponse;
  /** Fail `GET /events/types` — same contract as the service options. */
  typeOptionsError?: ErrorResponse;
  /**
   * Stand in for the service's `LIST_COUNT_CAP`. The real one counts a capped
   * subquery so an unfiltered list never reads the whole table, and reports
   * `totalCapped` when it hit the ceiling; this mirrors that rather than
   * letting a spec hand the UI a flag the service would not have sent.
   */
  countCap?: number;
}

export interface EventStoreRecorder {
  /** Query params of every `GET /events`, in call order. */
  eventListQueries: URLSearchParams[];
  /** Query params of every `GET /dlq`, in call order. */
  dlqListQueries: URLSearchParams[];
  /** Ids passed to `POST /dlq/:id/replay`, in call order. */
  replayedIds: string[];
  /** URLs that reached the tripwire — a non-empty list means a missing stub. */
  unmocked: string[];
}

export const EVENT_FIXTURES: EventFixture[] = [
  {
    id: "evt-1",
    type: "file.uploaded",
    service: "file-service",
    entityId: "file-aaa",
    ownerId: "google_e2e-test-user",
    correlationId: "corr-aaa",
    timestamp: "2026-09-01T10:00:00.000Z",
    payload: {
      blobName: "invoice.pdf",
      sizeBytes: 2048,
      origin: "chatbot",
      mime_type: "application/pdf",
    },
  },
  {
    id: "evt-2",
    type: "conversation.deleted",
    service: "chatbot-service",
    entityId: "conv-bbb",
    ownerId: "google_e2e-test-user",
    correlationId: "corr-bbb",
    timestamp: "2026-09-01T09:00:00.000Z",
    payload: {
      conversationId: "conv-bbb",
      origin: "messenger",
      mime_type: "image/png",
    },
  },
  {
    id: "evt-3",
    type: "auth.login",
    service: "api-gateway",
    entityId: null,
    ownerId: "google_e2e-test-user",
    correlationId: null,
    timestamp: "2026-09-01T08:00:00.000Z",
    payload: { provider: "google" },
  },
];

export const DLQ_FIXTURES: DlqFixture[] = [
  {
    id: "dlq-pending",
    subject: "dlq.file.conversation_cleanup",
    sink: "file.conversation_cleanup",
    originalSubject: "events.chatbot.conversation.deleted",
    ownerId: "google_e2e-test-user",
    correlationId: "corr-ccc",
    lastError: "blob delete timed out after 3 attempts",
    failedAt: "2026-09-02T10:00:00.000Z",
    payload: { conversationId: "conv-ccc" },
    envelope: { id: "evt-ccc", type: "conversation.deleted" },
    ingestedAt: "2026-09-02T10:00:01.000Z",
    replayedAt: null,
    jetstreamStream: "DLQ",
    jetstreamSequence: "41",
  },
  {
    id: "dlq-replayed",
    subject: "dlq.event_store.ingest",
    sink: "event_store.ingest",
    originalSubject: "events.file.uploaded",
    ownerId: "google_e2e-test-user",
    correlationId: "corr-ddd",
    lastError: "duplicate key value violates unique constraint",
    failedAt: "2026-09-02T09:00:00.000Z",
    payload: { blobName: "notes.txt" },
    envelope: { id: "evt-ddd", type: "file.uploaded" },
    ingestedAt: "2026-09-02T09:00:01.000Z",
    replayedAt: "2026-09-02T11:00:00.000Z",
    jetstreamStream: "DLQ",
    jetstreamSequence: "42",
  },
  {
    id: "dlq-no-envelope",
    subject: "dlq.event_store.ingest",
    sink: "event_store.ingest",
    originalSubject: "events.file.deleted",
    ownerId: null,
    correlationId: null,
    lastError: "envelope failed schema validation",
    failedAt: "2026-09-02T08:00:00.000Z",
    payload: { raw: "not-an-envelope" },
    envelope: null,
    ingestedAt: "2026-09-02T08:00:01.000Z",
    replayedAt: null,
    jetstreamStream: "DLQ",
    jetstreamSequence: "43",
  },
];

/** N events, newest first — enough rows to page past EVENTS_PAGE_SIZE (50). */
export function makeEvents(count: number): EventFixture[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `evt-page-${i + 1}`,
    type: `bulk.event.${i + 1}`,
    service: "file-service",
    entityId: `entity-${i + 1}`,
    ownerId: "google_e2e-test-user",
    correlationId: `corr-${i + 1}`,
    timestamp: new Date(Date.UTC(2026, 8, 1, 12, 0, count - i)).toISOString(),
    payload: { index: i + 1 },
  }));
}

/** N DLQ records, newest first. */
export function makeDlqRecords(count: number): DlqFixture[] {
  return Array.from({ length: count }, (_, i) => ({
    ...DLQ_FIXTURES[0],
    id: `dlq-page-${i + 1}`,
    originalSubject: `events.bulk.${i + 1}`,
    correlationId: `corr-dlq-${i + 1}`,
    failedAt: new Date(Date.UTC(2026, 8, 2, 12, 0, count - i)).toISOString(),
    jetstreamSequence: String(i + 1),
  }));
}

function fail(route: Route, error: ErrorResponse): Promise<void> {
  return route.fulfill({
    status: error.status,
    json: error.body ?? { error: `e2e-${error.status}` },
  });
}

/**
 * Page a dataset the way the service does: `limit`/`offset` off the query, with
 * `total` always the full count. Stubbing by call order instead breaks the
 * moment a page re-fetches (filter change, sort toggle) — the documented lesson
 * from the chatbot suite.
 */
function paged<T>(rows: T[], query: URLSearchParams, countCap?: number) {
  const limit = Number(query.get("limit") ?? rows.length);
  const offset = Number(query.get("offset") ?? 0);
  const cap = countCap ?? Number.POSITIVE_INFINITY;
  return {
    data: rows.slice(offset, offset + limit),
    total: Math.min(rows.length, cap),
    totalCapped: rows.length > cap,
  };
}

/**
 * The events list, paged the way the service pages it: by offset while the
 * total is exact, by keyset cursor past the cap.
 *
 * The cursor is opaque to the client, so the mock is free to make it an index —
 * what matters is that a spec can only move by feeding back what the previous
 * response gave it, which is the whole contract under test. `total` ignores the
 * cursor here for the same reason it does in the service: it describes the
 * result set, not the page.
 */
function pagedEvents(
  rows: EventFixture[],
  query: URLSearchParams,
  countCap?: number,
) {
  const limit = Number(query.get("limit") ?? rows.length);
  const cap = countCap ?? Number.POSITIVE_INFINITY;
  const after = query.get("after");
  const start = after
    ? Number(Buffer.from(after, "base64url").toString("utf8")) + 1
    : Number(query.get("offset") ?? 0);

  const window = rows.slice(start, start + limit);
  const hasMore = start + limit < rows.length;
  return {
    data: window,
    total: Math.min(rows.length, cap),
    totalCapped: rows.length > cap,
    nextCursor: hasMore
      ? Buffer.from(String(start + limit - 1), "utf8").toString("base64url")
      : null,
  };
}

export async function mockEventStoreApi(
  page: Page,
  options: EventStoreMockOptions = {},
): Promise<EventStoreRecorder> {
  const events = options.events ?? EVENT_FIXTURES;
  const dlq = options.dlq ?? DLQ_FIXTURES;

  const recorder: EventStoreRecorder = {
    eventListQueries: [],
    dlqListQueries: [],
    replayedIds: [],
    unmocked: [],
  };

  // Tripwire, registered first so every real stub outranks it. Without it a
  // missing stub reaches the real gateway on :8080, which 401s the seeded JWT
  // and pops the global error dialog — a failure that looks nothing like its
  // cause.
  await page.route("**/api/**", async (route) => {
    recorder.unmocked.push(route.request().url());
    await route.fulfill({
      status: 599,
      json: { error: "unmocked request", url: route.request().url() },
    });
  });

  await page.route("**/api/event-store/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^.*\/api\/event-store/, "");
    const query = url.searchParams;
    const method = route.request().method();

    if (path === "/events") {
      recorder.eventListQueries.push(query);
      if (options.eventsListError) {
        return fail(route, options.eventsListError);
      }
      return route.fulfill({
        json: pagedEvents(events, query, options.countCap),
      });
    }

    /* The filter options. Derived from the fixtures rather than listed, so a
       spec that changes the data cannot leave the dropdown describing the old
       set — which is the exact drift that made these endpoints necessary.

       Both must be matched before the `/events/:id` and `/dlq/:id` regexes
       below, which would otherwise take `services` and `sinks` for record ids
       and 404 them. The service's router has the same collision and pins it
       with its own test. */
    if (path === "/events/services") {
      if (options.serviceOptionsError) {
        return fail(route, options.serviceOptionsError);
      }
      return route.fulfill({
        json: { data: distinct(events.map((event) => event.service)) },
      });
    }

    /* Same collision and same derivation as `/events/services`. */
    if (path === "/events/types") {
      if (options.typeOptionsError) {
        return fail(route, options.typeOptionsError);
      }
      return route.fulfill({
        json: { data: distinct(events.map((event) => event.type)) },
      });
    }

    /* The payload filter's own menus, derived from the fixtures for the same
       reason as the service list: a spec that changes the data cannot leave the
       dropdown describing the old set. */
    if (path === "/events/payload-keys") {
      const keys = new Set<string>();
      for (const event of events) {
        for (const key of Object.keys(event.payload as object)) keys.add(key);
      }
      return route.fulfill({ json: { data: distinct([...keys]) } });
    }

    if (path === "/events/payload-values") {
      const key = query.get("key") ?? "";
      const values = events
        .map((event) => (event.payload as Record<string, unknown>)[key])
        .filter((value) => value !== undefined && value !== null)
        .filter((value) => typeof value !== "object")
        .map(String);
      return route.fulfill({ json: { data: distinct(values) } });
    }

    if (path === "/dlq/sinks") {
      return route.fulfill({
        json: { data: distinct(dlq.map((record) => record.sink)) },
      });
    }

    if (path === "/dlq") {
      recorder.dlqListQueries.push(query);
      if (options.dlqListError) {
        return fail(route, options.dlqListError);
      }
      return route.fulfill({ json: paged(dlq, query, options.countCap) });
    }

    const replayMatch = /^\/dlq\/([^/]+)\/replay$/.exec(path);
    if (replayMatch && method === "POST") {
      const id = decodeURIComponent(replayMatch[1]);
      recorder.replayedIds.push(id);
      if (options.replayError) {
        return fail(route, options.replayError);
      }
      const record = dlq.find((item) => item.id === id);
      return route.fulfill({
        json: {
          id,
          originalSubject: record?.originalSubject ?? "events.unknown",
          replayedAt: new Date().toISOString(),
        },
      });
    }

    const eventMatch = /^\/events\/([^/]+)$/.exec(path);
    if (eventMatch) {
      if (options.eventDetailError) {
        return fail(route, options.eventDetailError);
      }
      const id = decodeURIComponent(eventMatch[1]);
      const record = events.find((item) => item.id === id);
      return record
        ? route.fulfill({ json: record })
        : fail(route, { status: 404 });
    }

    const dlqMatch = /^\/dlq\/([^/]+)$/.exec(path);
    if (dlqMatch) {
      if (options.dlqDetailError) {
        return fail(route, options.dlqDetailError);
      }
      const id = decodeURIComponent(dlqMatch[1]);
      const record = dlq.find((item) => item.id === id);
      return record
        ? route.fulfill({ json: record })
        : fail(route, { status: 404 });
    }

    // Unknown event-store path: let the tripwire record it.
    return route.fallback();
  });

  return recorder;
}
