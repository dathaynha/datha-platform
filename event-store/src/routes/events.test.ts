import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import eventsRoutes from "./events";

vi.mock("../services/query", () => ({
  queryEvents: vi.fn(),
  getEventById: vi.fn(),
  listEventServices: vi.fn(),
  listEventTypes: vi.fn(),
  listPayloadKeys: vi.fn(),
  listPayloadValues: vi.fn(),
}));

import {
  getEventById,
  listEventServices,
  listEventTypes,
  listPayloadKeys,
  listPayloadValues,
  queryEvents,
} from "../services/query";

const EVENT_ID = "11111111-1111-4111-8111-111111111111";

describe("GET /events", () => {
  let app: FastifyInstance;
  let db: Pool;

  beforeEach(async () => {
    db = {} as Pool;
    app = Fastify({ logger: false });
    app.decorate("db", db);
    await app.register(eventsRoutes);
    await app.ready();
    vi.mocked(queryEvents).mockResolvedValue({
      data: [],
      total: 0,
      totalCapped: false,
      nextCursor: null,
    });
  });

  afterEach(async () => {
    await app.close();
    vi.clearAllMocks();
  });

  it("passes order=asc to queryEvents", async () => {
    const res = await app.inject({ method: "GET", url: "/events?order=asc" });

    expect(res.statusCode).toBe(200);
    expect(queryEvents).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ order: "asc" }),
    );
  });

  it("passes order=desc to queryEvents", async () => {
    const res = await app.inject({ method: "GET", url: "/events?order=desc" });

    expect(res.statusCode).toBe(200);
    expect(queryEvents).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ order: "desc" }),
    );
  });

  it("omits order when query param absent", async () => {
    const res = await app.inject({ method: "GET", url: "/events" });

    expect(res.statusCode).toBe(200);
    expect(queryEvents).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ order: undefined }),
    );
  });

  it("passes a decoded cursor to queryEvents", async () => {
    const after = Buffer.from(
      "2026-09-01T10:00:00.000Z|11111111-1111-4111-8111-111111111111",
    ).toString("base64url");

    const res = await app.inject({
      method: "GET",
      url: `/events?after=${after}`,
    });

    expect(res.statusCode).toBe(200);
    expect(queryEvents).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        after: {
          timestamp: "2026-09-01T10:00:00.000Z",
          id: "11111111-1111-4111-8111-111111111111",
        },
      }),
    );
  });

  it("rejects a malformed cursor rather than silently paging from the top", async () => {
    // The dangerous failure is not the 400 — it is the alternative. Someone
    // deep in a list whose cursor is mangled would see page one and read it as
    // the data having gone.
    const res = await app.inject({
      method: "GET",
      url: "/events?after=not-a-real-cursor",
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "Invalid cursor" });
    expect(queryEvents).not.toHaveBeenCalled();
  });

  it("passes payload.* filters through as a payload object", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/events?payload.origin=messenger&payload.mime_type=image/png",
    });

    expect(res.statusCode).toBe(200);
    expect(queryEvents).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        payload: { origin: "messenger", mime_type: "image/png" },
      }),
    );
  });

  it("omits payload entirely when none was asked for", async () => {
    await app.inject({ method: "GET", url: "/events" });

    expect(queryEvents).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ payload: undefined }),
    );
  });

  it.each([
    ["a key with a dash", "/events?payload.bad-key=x"],
    ["a key with a dot", "/events?payload.a.b=x"],
    ["an empty value", "/events?payload.origin="],
  ])("rejects %s rather than ignoring it", async (_name, url) => {
    // Silently dropping a filter returns *more* rows than asked for, which
    // reads as the filter not working rather than as a bad request.
    const res = await app.inject({ method: "GET", url });

    expect(res.statusCode).toBe(400);
    expect(queryEvents).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid order", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/events?order=invalid",
    });

    expect(res.statusCode).toBe(400);
    expect(queryEvents).not.toHaveBeenCalled();
  });
});

describe("GET /events/:id", () => {
  let app: FastifyInstance;
  let db: Pool;

  beforeEach(async () => {
    db = {} as Pool;
    app = Fastify({ logger: false });
    app.decorate("db", db);
    await app.register(eventsRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    vi.clearAllMocks();
  });

  it("returns the event when found", async () => {
    const event = {
      id: EVENT_ID,
      type: "file.uploaded",
      service: "file-service",
      entityId: "ent-1",
      ownerId: "google_u1",
      correlationId: "corr-1",
      timestamp: "2026-01-01T12:00:00.000Z",
      payload: {},
    };
    vi.mocked(getEventById).mockResolvedValue(event);

    const res = await app.inject({ method: "GET", url: `/events/${EVENT_ID}` });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual(event);
    expect(getEventById).toHaveBeenCalledWith(db, EVENT_ID);
  });

  it("returns 404 when event not found", async () => {
    vi.mocked(getEventById).mockResolvedValue(null);

    const res = await app.inject({ method: "GET", url: `/events/${EVENT_ID}` });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "Event not found" });
  });

  it("returns 400 for invalid uuid", async () => {
    const res = await app.inject({ method: "GET", url: "/events/not-a-uuid" });

    expect(res.statusCode).toBe(400);
    expect(getEventById).not.toHaveBeenCalled();
  });
});

describe("GET /events/services", () => {
  let app: FastifyInstance;
  let db: Pool;

  beforeEach(async () => {
    db = {} as Pool;
    app = Fastify({ logger: false });
    app.decorate("db", db);
    await app.register(eventsRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    vi.clearAllMocks();
  });

  it("returns the distinct services", async () => {
    vi.mocked(listEventServices).mockResolvedValue([
      "api-gateway",
      "messenger-service",
    ]);

    const res = await app.inject({ method: "GET", url: "/events/services" });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      data: ["api-gateway", "messenger-service"],
    });
  });

  // `services` is a path segment in the same position as an event id, so this
  // pins that the static route wins. Were it matched by `/events/:id` the
  // request would 400 on the uuid schema and the filter would never load.
  it("is not swallowed by /events/:id", async () => {
    vi.mocked(listEventServices).mockResolvedValue([]);

    const res = await app.inject({ method: "GET", url: "/events/services" });

    expect(res.statusCode).toBe(200);
    expect(getEventById).not.toHaveBeenCalled();
  });

  it("returns 500 when the query fails", async () => {
    vi.mocked(listEventServices).mockRejectedValue(new Error("boom"));

    const res = await app.inject({ method: "GET", url: "/events/services" });

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: "Internal server error" });
  });
});

describe("GET /events/types", () => {
  let app: FastifyInstance;
  let db: Pool;

  beforeEach(async () => {
    db = {} as Pool;
    app = Fastify({ logger: false });
    app.decorate("db", db);
    await app.register(eventsRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    vi.clearAllMocks();
  });

  it("returns the distinct types", async () => {
    vi.mocked(listEventTypes).mockResolvedValue([
      "file.deleted",
      "file.uploaded",
    ]);

    const res = await app.inject({ method: "GET", url: "/events/types" });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      data: ["file.deleted", "file.uploaded"],
    });
  });

  // Same collision as `/events/services`: `types` sits where an event id goes.
  it("is not swallowed by /events/:id", async () => {
    vi.mocked(listEventTypes).mockResolvedValue([]);

    const res = await app.inject({ method: "GET", url: "/events/types" });

    expect(res.statusCode).toBe(200);
    expect(getEventById).not.toHaveBeenCalled();
  });

  it("returns 500 when the query fails", async () => {
    vi.mocked(listEventTypes).mockRejectedValue(new Error("boom"));

    const res = await app.inject({ method: "GET", url: "/events/types" });

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: "Internal server error" });
  });
});

/**
 * The payload filter's own menus. Static segments in the same position as an
 * event id, so the collision with `/events/:id` is pinned here too.
 */
describe("GET /events/payload-keys and /events/payload-values", () => {
  let app: FastifyInstance;
  let db: Pool;

  beforeEach(async () => {
    db = {} as Pool;
    app = Fastify({ logger: false });
    app.decorate("db", db);
    await app.register(eventsRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    vi.clearAllMocks();
  });

  it("lists the payload keys", async () => {
    vi.mocked(listPayloadKeys).mockResolvedValue(["mime_type", "origin"]);

    const res = await app.inject({
      method: "GET",
      url: "/events/payload-keys",
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ data: ["mime_type", "origin"] });
    expect(getEventById).not.toHaveBeenCalled();
  });

  it("lists the values for one key", async () => {
    vi.mocked(listPayloadValues).mockResolvedValue(["chatbot", "messenger"]);

    const res = await app.inject({
      method: "GET",
      url: "/events/payload-values?key=origin",
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ data: ["chatbot", "messenger"] });
    expect(listPayloadValues).toHaveBeenCalledWith(db, "origin");
  });

  it.each([
    ["missing", "/events/payload-values"],
    ["not an identifier", "/events/payload-values?key=bad-key"],
  ])("rejects a key that is %s", async (_name, url) => {
    const res = await app.inject({ method: "GET", url });

    expect(res.statusCode).toBe(400);
    expect(listPayloadValues).not.toHaveBeenCalled();
  });

  it("returns 500 when the lookup fails", async () => {
    vi.mocked(listPayloadKeys).mockRejectedValue(new Error("boom"));

    const res = await app.inject({
      method: "GET",
      url: "/events/payload-keys",
    });

    expect(res.statusCode).toBe(500);
  });
});
