import type { JsMsg } from "@nats-io/jetstream";
import type { FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleMessage, toProjection } from "./calls-consumer";
import type { PlatformEvent } from "../types/events";

const CALL_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";

function envelope(overrides: Partial<PlatformEvent> = {}): PlatformEvent {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    type: "messenger.call.started",
    service: "realtime-service",
    entity_id: CALL_ID,
    owner_id: "google_1",
    correlation_id: CALL_ID,
    timestamp: "2026-09-09T10:00:05.000Z",
    payload: {
      call_id: CALL_ID,
      conversation_id: CONVERSATION_ID,
      caller_id: "google_1",
      callee_id: "google_2",
      started_at: "2026-09-09T10:00:00.000Z",
      answered_at: "2026-09-09T10:00:05.000Z",
    },
    ...overrides,
  };
}

/** A group call event: no callee, described by its participants instead. */
function groupEnvelope(overrides: Record<string, unknown> = {}): PlatformEvent {
  const base = envelope();
  const { callee_id: _dropped, ...payload } = base.payload;
  return {
    ...base,
    payload: {
      ...payload,
      participant_ids: ["google_1", "google_2", "google_3"],
      joined_ids: ["google_1", "google_2"],
      ...overrides,
    },
  };
}

function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

type FakeMsg = JsMsg & {
  ack: ReturnType<typeof vi.fn>;
  nak: ReturnType<typeof vi.fn>;
  term: ReturnType<typeof vi.fn>;
};

function message(data: Uint8Array, deliveryCount = 1): FakeMsg {
  return {
    data,
    subject: "events.messenger.call.started",
    info: { deliveryCount },
    ack: vi.fn(),
    nak: vi.fn(),
    term: vi.fn(),
  } as unknown as FakeMsg;
}

let projected: ReturnType<typeof vi.fn>;
let publish: ReturnType<typeof vi.fn>;
let query: ReturnType<typeof vi.fn>;

function app(): FastifyInstance {
  projected = vi.fn();
  publish = vi.fn().mockResolvedValue(undefined);
  query = vi.fn().mockResolvedValue({ rows: [] });
  // The projection runs in a transaction now, so the pool has to hand back a
  // client; both share one mock so assertions do not care which ran a statement.
  return {
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    db: {
      query,
      connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
    },
    js: { publish },
    metrics: { callsProjected: { inc: projected } },
  } as unknown as FastifyInstance;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("toProjection", () => {
  it("reads a started event, leaving the call open", () => {
    const input = toProjection(envelope());
    expect(input).toEqual({
      callId: CALL_ID,
      conversationId: CONVERSATION_ID,
      callerOwnerId: "google_1",
      calleeOwnerId: "google_2",
      // Absent from a pre-phase-3 payload, which is every 1:1 event published
      // before the room model.
      participantOwnerIds: [],
      joinedOwnerIds: [],
      // Absent from the payload, as it is in every event published before
      // phase 2.5, so it reads as audio.
      media: "audio",
      startedAt: "2026-09-09T10:00:00.000Z",
      answeredAt: "2026-09-09T10:00:05.000Z",
      endedAt: null,
      endReason: null,
      durationSeconds: 0,
    });
  });

  it("reads the media kind when the event carries one", () => {
    const input = toProjection(
      envelope({
        payload: {
          call_id: CALL_ID,
          conversation_id: CONVERSATION_ID,
          caller_id: "google_1",
          callee_id: "google_2",
          media: "video",
          started_at: "2026-09-09T10:00:00.000Z",
        },
      }),
    );
    expect(input?.media).toBe("video");
  });

  it("treats an unrecognised media kind as audio", () => {
    // The column is constrained, so anything else would fail the insert and
    // stall the durable on a message that can never succeed.
    const input = toProjection(
      envelope({
        payload: {
          call_id: CALL_ID,
          conversation_id: CONVERSATION_ID,
          caller_id: "google_1",
          callee_id: "google_2",
          media: "screen",
          started_at: "2026-09-09T10:00:00.000Z",
        },
      }),
    );
    expect(input?.media).toBe("audio");
  });

  it("stamps ended_at from the envelope timestamp", () => {
    // The publisher stamps the envelope at the moment the call ends, and the
    // payload carries no ended_at of its own.
    const input = toProjection(
      envelope({
        type: "messenger.call.ended",
        timestamp: "2026-09-09T10:03:05.000Z",
        payload: {
          ...envelope().payload,
          reason: "hangup",
          duration_seconds: 180,
        },
      }),
    );
    expect(input?.endedAt).toBe("2026-09-09T10:03:05.000Z");
    expect(input?.endReason).toBe("hangup");
    expect(input?.durationSeconds).toBe(180);
  });

  it("defaults a missed event's reason even if the payload omits it", () => {
    const input = toProjection(
      envelope({
        type: "messenger.call.missed",
        payload: {
          call_id: CALL_ID,
          conversation_id: CONVERSATION_ID,
          caller_id: "google_1",
          callee_id: "google_2",
          started_at: "2026-09-09T10:00:00.000Z",
        },
      }),
    );
    expect(input?.endReason).toBe("missed");
    expect(input?.answeredAt).toBeNull();
  });

  it("discards a reason the column would reject", () => {
    // `answered_elsewhere` is a live socket reason, not a history one, and the
    // CHECK constraint would refuse it — so it must not reach the insert.
    const input = toProjection(
      envelope({
        type: "messenger.call.ended",
        payload: { ...envelope().payload, reason: "answered_elsewhere" },
      }),
    );
    expect(input?.endReason).toBe("hangup");
  });

  it("ignores events from outside the call namespace", () => {
    expect(
      toProjection(envelope({ type: "messenger.message.sent" })),
    ).toBeNull();
  });

  it("ignores an event whose ids are not uuids", () => {
    // Both are database keys; a bad one would fail the insert and cycle
    // pointlessly through the DLQ instead of being dropped here.
    for (const payload of [
      { ...envelope().payload, call_id: "not-a-uuid" },
      { ...envelope().payload, conversation_id: "not-a-uuid" },
    ]) {
      expect(toProjection(envelope({ payload }))).toBeNull();
    }
  });

  it("ignores an event missing a participant or a start time", () => {
    for (const key of ["caller_id", "callee_id", "started_at"]) {
      const payload = { ...envelope().payload };
      delete (payload as Record<string, unknown>)[key];
      expect(toProjection(envelope({ payload }))).toBeNull();
    }
  });

  it("floors a negative or fractional duration to a non-negative integer", () => {
    // The column has CHECK (duration_seconds >= 0).
    for (const [given, want] of [
      [-5, 0],
      [1.9, 1],
      [Number.NaN, 0],
    ] as const) {
      const input = toProjection(
        envelope({
          type: "messenger.call.ended",
          payload: { ...envelope().payload, duration_seconds: given },
        }),
      );
      expect(input?.durationSeconds).toBe(want);
    }
  });
});

describe("handleMessage", () => {
  it("projects a group call, which has no callee at all", async () => {
    // Before the room model this event was dropped on the floor: the parser
    // required a callee, so four working endpoints' worth of group calls
    // would have produced no history whatsoever.
    const input = toProjection(groupEnvelope());
    expect(input).toMatchObject({
      calleeOwnerId: null,
      participantOwnerIds: ["google_1", "google_2", "google_3"],
      joinedOwnerIds: ["google_1", "google_2"],
    });
  });

  it("ignores an event with neither a callee nor participants", async () => {
    // Not a call this projection understands. Returning null acks and moves on
    // rather than retrying three times into the DLQ — a malformed or foreign
    // event is the producer's problem.
    expect(toProjection(groupEnvelope({ participant_ids: [] }))).toBeNull();
  });

  it("reads an unanswered group call as invited-but-nobody-joined", async () => {
    const input = toProjection(groupEnvelope({ joined_ids: [] }));
    expect(input?.joinedOwnerIds).toEqual([]);
    expect(input?.participantOwnerIds).toHaveLength(3);
  });

  it("ignores non-string entries in a participant list", async () => {
    const input = toProjection(
      groupEnvelope({ participant_ids: ["google_1", 42, null, "google_2"] }),
    );
    expect(input?.participantOwnerIds).toEqual(["google_1", "google_2"]);
  });

  it("projects and acks a valid event", async () => {
    const fastify = app();
    const msg = message(encode(envelope()));
    await handleMessage(fastify, msg);

    // BEGIN, the call upsert, the conversation's activity bump, COMMIT — the
    // participant statement is skipped for an event that carries none.
    // Asserted by what each statement is rather than by how many there are, so
    // adding one to the transaction does not fail an unrelated rule.
    const sql = query.mock.calls.map(([text]) => String(text).trim());
    expect(sql[0]).toBe("BEGIN");
    expect(sql.at(-1)).toBe("COMMIT");
    expect(sql.some((text) => text.startsWith("INSERT INTO calls"))).toBe(true);
    expect(sql.some((text) => text.startsWith("UPDATE conversations"))).toBe(
      true,
    );
    expect(sql.some((text) => text.includes("call_participants"))).toBe(false);
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(projected).toHaveBeenCalledWith({ outcome: "projected" });
  });

  it("terminates an undecodable message rather than retrying it", async () => {
    const fastify = app();
    const msg = message(new TextEncoder().encode("not json"));
    await handleMessage(fastify, msg);

    // A malformed envelope will never decode on the third attempt either.
    expect(msg.term).toHaveBeenCalledOnce();
    expect(msg.nak).not.toHaveBeenCalled();
    expect(projected).toHaveBeenCalledWith({ outcome: "invalid" });
  });

  it("acks an event it does not project, without touching the database", async () => {
    const fastify = app();
    const msg = message(encode(envelope({ type: "messenger.message.sent" })));
    await handleMessage(fastify, msg);

    expect(query).not.toHaveBeenCalled();
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(projected).toHaveBeenCalledWith({ outcome: "ignored" });
  });

  it("naks a transient write failure so it is retried", async () => {
    const fastify = app();
    query.mockRejectedValueOnce(new Error("connection terminated"));
    const msg = message(encode(envelope()), 1);
    await handleMessage(fastify, msg);

    expect(msg.nak).toHaveBeenCalledOnce();
    expect(publish).not.toHaveBeenCalled();
  });

  it("terminates a call for a conversation that no longer exists", async () => {
    const fastify = app();
    // The conversation was deleted, so its calls cascaded away. Retrying
    // cannot succeed, and this is not a DLQ case either.
    query.mockRejectedValueOnce(
      Object.assign(new Error("violates foreign key constraint"), {
        code: "23503",
      }),
    );
    const msg = message(encode(envelope()), 1);
    await handleMessage(fastify, msg);

    expect(msg.term).toHaveBeenCalledOnce();
    expect(msg.nak).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(projected).toHaveBeenCalledWith({ outcome: "orphaned" });
  });

  it("publishes to the DLQ and acks once max_deliver is exhausted", async () => {
    const fastify = app();
    query.mockRejectedValue(new Error("connection terminated"));
    const msg = message(encode(envelope()), 3);
    await handleMessage(fastify, msg);

    expect(publish).toHaveBeenCalledOnce();
    const [subject] = publish.mock.calls[0];
    expect(subject).toBe("events.dlq.messenger_service.calls");
    // Acked, not nak'd: another retry would loop forever on the same failure.
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(projected).toHaveBeenCalledWith({ outcome: "dlq" });
  });

  it("carries the failing envelope into the DLQ record", async () => {
    const fastify = app();
    query.mockRejectedValue(new Error("disk full"));
    await handleMessage(fastify, message(encode(envelope()), 3));

    const [, data] = publish.mock.calls[0];
    const body = JSON.parse(new TextDecoder().decode(data as Uint8Array));
    expect(body.last_error).toBe("disk full");
    expect(body.original_subject).toBe("events.messenger.call.started");
    expect(body.correlation_id).toBe(CALL_ID);
    expect(body.failed_at).toBeTypeOf("string");
    expect(body.envelope.id).toBe("33333333-3333-4333-8333-333333333333");
  });
});
