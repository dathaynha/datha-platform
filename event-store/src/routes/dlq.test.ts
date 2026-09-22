import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import dlqRoutes from "./dlq";

vi.mock("../services/dlq-query", () => ({
  queryDlqRecords: vi.fn(),
  getDlqRecordById: vi.fn(),
  listDlqSinks: vi.fn(),
}));

vi.mock("../services/dlq-replay", () => ({
  replayDlqRecord: vi.fn(),
  DlqReplayError: class DlqReplayError extends Error {
    constructor(
      message: string,
      readonly statusCode: number,
    ) {
      super(message);
    }
  },
}));

import {
  getDlqRecordById,
  listDlqSinks,
  queryDlqRecords,
} from "../services/dlq-query";

describe("GET /dlq", () => {
  let app: FastifyInstance;
  let db: Pool;

  beforeEach(async () => {
    db = {} as Pool;
    app = Fastify({ logger: false });
    app.decorate("db", db);
    app.decorate("js", {} as never);
    await app.register(dlqRoutes);
    await app.ready();
    vi.mocked(queryDlqRecords).mockResolvedValue({
      data: [],
      total: 0,
      totalCapped: false,
    });
  });

  afterEach(async () => {
    await app.close();
    vi.clearAllMocks();
  });

  it("passes order=asc to queryDlqRecords", async () => {
    const res = await app.inject({ method: "GET", url: "/dlq?order=asc" });

    expect(res.statusCode).toBe(200);
    expect(queryDlqRecords).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ order: "asc" }),
    );
  });

  it("passes order=desc to queryDlqRecords", async () => {
    const res = await app.inject({ method: "GET", url: "/dlq?order=desc" });

    expect(res.statusCode).toBe(200);
    expect(queryDlqRecords).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ order: "desc" }),
    );
  });

  it("omits order when query param absent", async () => {
    const res = await app.inject({ method: "GET", url: "/dlq" });

    expect(res.statusCode).toBe(200);
    expect(queryDlqRecords).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ order: undefined }),
    );
  });

  it("returns 400 for invalid order", async () => {
    const res = await app.inject({ method: "GET", url: "/dlq?order=invalid" });

    expect(res.statusCode).toBe(400);
    expect(queryDlqRecords).not.toHaveBeenCalled();
  });
});

describe("GET /dlq/sinks", () => {
  let app: FastifyInstance;
  let db: Pool;

  beforeEach(async () => {
    db = {} as Pool;
    app = Fastify({ logger: false });
    app.decorate("db", db);
    app.decorate("js", {} as never);
    await app.register(dlqRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    vi.clearAllMocks();
  });

  it("returns the distinct sinks", async () => {
    vi.mocked(listDlqSinks).mockResolvedValue(["messenger_service.calls"]);

    const res = await app.inject({ method: "GET", url: "/dlq/sinks" });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      data: ["messenger_service.calls"],
    });
  });

  // Same shape as `/events/services`: a static segment where an id goes.
  it("is not swallowed by /dlq/:id", async () => {
    vi.mocked(listDlqSinks).mockResolvedValue([]);

    const res = await app.inject({ method: "GET", url: "/dlq/sinks" });

    expect(res.statusCode).toBe(200);
    expect(getDlqRecordById).not.toHaveBeenCalled();
  });

  it("returns 500 when the query fails", async () => {
    vi.mocked(listDlqSinks).mockRejectedValue(new Error("boom"));

    const res = await app.inject({ method: "GET", url: "/dlq/sinks" });

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: "Internal server error" });
  });
});
