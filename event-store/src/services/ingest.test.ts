import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { PlatformEvent } from "../types/events";
import { ingestEvent, parseEnvelope } from "./ingest";

const EVENT_ID = "11111111-1111-4111-8111-111111111111";

function validEnvelope(overrides: Partial<PlatformEvent> = {}): PlatformEvent {
  return {
    id: EVENT_ID,
    type: "file.uploaded",
    service: "file-service",
    entity_id: "22222222-2222-4222-8222-222222222222",
    owner_id: "google_owner",
    correlation_id: "corr-1",
    timestamp: "2026-01-01T00:00:00.000Z",
    payload: { file_id: "22222222-2222-4222-8222-222222222222" },
    ...overrides,
  };
}

function encode(envelope: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(envelope));
}

describe("parseEnvelope", () => {
  it("accepts a valid platform envelope", () => {
    const parsed = parseEnvelope(encode(validEnvelope()));
    expect(parsed.type).toBe("file.uploaded");
    expect(parsed.owner_id).toBe("google_owner");
  });

  it("rejects non-object JSON", () => {
    expect(() => parseEnvelope(encode("hello"))).toThrow(
      "envelope must be a JSON object",
    );
  });

  it("rejects invalid uuid id", () => {
    expect(() =>
      parseEnvelope(encode(validEnvelope({ id: "not-a-uuid" }))),
    ).toThrow("envelope.id must be a uuid v4 string");
  });

  it("rejects missing type and service", () => {
    expect(() =>
      parseEnvelope(encode({ ...validEnvelope(), type: "" })),
    ).toThrow("envelope.type is required");
    expect(() =>
      parseEnvelope(encode({ ...validEnvelope(), service: "" })),
    ).toThrow("envelope.service is required");
  });

  it("accepts omitted correlation_id, entity_id, and owner_id as null", () => {
    const {
      correlation_id: _c,
      entity_id: _e,
      owner_id: _o,
      ...rest
    } = validEnvelope();
    const parsed = parseEnvelope(encode(rest));
    expect(parsed.correlation_id).toBeNull();
    expect(parsed.entity_id).toBeNull();
    expect(parsed.owner_id).toBeNull();
  });

  it("rejects invalid entity_id, owner_id, and correlation_id types", () => {
    expect(() =>
      parseEnvelope(encode({ ...validEnvelope(), entity_id: 123 })),
    ).toThrow("envelope.entity_id must be string or null");
    expect(() =>
      parseEnvelope(encode({ ...validEnvelope(), owner_id: 123 })),
    ).toThrow("envelope.owner_id must be string or null");
    expect(() =>
      parseEnvelope(encode({ ...validEnvelope(), correlation_id: 99 })),
    ).toThrow("envelope.correlation_id must be string or null");
  });

  it("rejects bad timestamp and non-object payload", () => {
    expect(() =>
      parseEnvelope(encode({ ...validEnvelope(), timestamp: "not-a-date" })),
    ).toThrow("envelope.timestamp must be ISO 8601");
    expect(() =>
      parseEnvelope(encode({ ...validEnvelope(), payload: [] })),
    ).toThrow("envelope.payload must be a JSON object");
  });

  it("rejects invalid JSON", () => {
    expect(() => parseEnvelope(new TextEncoder().encode("{"))).toThrow();
  });
});

describe("ingestEvent", () => {
  it("inserts with ON CONFLICT (id, timestamp) DO NOTHING (idempotent)", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const db = { query } as unknown as Pool;
    const envelope = validEnvelope();

    await ingestEvent(db, envelope);

    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0][0]).toContain(
      'ON CONFLICT (id, "timestamp") DO NOTHING',
    );
    expect(query.mock.calls[0][1]).toEqual([
      envelope.id,
      envelope.type,
      envelope.service,
      envelope.entity_id,
      envelope.owner_id,
      envelope.correlation_id,
      envelope.timestamp,
      JSON.stringify(envelope.payload),
    ]);
  });
});
