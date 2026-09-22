import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  asEndReason,
  listConversationCalls,
  listOwnerCalls,
  projectCall,
} from "./calls";
import { callStatus, toCall, type CallRow } from "../types/messenger";

/**
 * One query mock shared by the pool and by the client `connect()` hands back,
 * so a projection that runs inside a transaction records its statements in the
 * same place a plain read does.
 *
 * These specs assert on the SQL **text**: they never execute it, so they catch
 * a clause going missing and prove nothing about whether Postgres accepts it.
 * That half is covered by running the real statements against a real database
 * — see `.claude/rules/working-agreement.md` on doubles that mirror rather
 * than run.
 */
function mockDb(rows: unknown[] = []): Pool {
  const query = vi.fn().mockResolvedValue({ rows });
  const client = { query, release: vi.fn() };
  return {
    query,
    connect: vi.fn().mockResolvedValue(client),
  } as unknown as Pool;
}

/** The statements that are not transaction control, in order. */
function statements(db: Pool): { sql: string; params: unknown[] }[] {
  const mock = db.query as ReturnType<typeof vi.fn>;
  return mock.mock.calls
    .map(([sql, params]) => ({
      sql: String(sql).replace(/\s+/g, " "),
      params: params as unknown[],
    }))
    .filter(({ sql }) => !/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql.trim()));
}

/** Collapses SQL whitespace so assertions do not depend on column alignment. */
function sqlOf(db: Pool, call = 0): string {
  return statements(db)[call].sql;
}

function paramsOf(db: Pool, call = 0): unknown[] {
  return statements(db)[call].params;
}

const STARTED = new Date("2026-09-09T10:00:00.000Z");
const ANSWERED = new Date("2026-09-09T10:00:05.000Z");
const ENDED = new Date("2026-09-09T10:03:05.000Z");

function row(overrides: Partial<CallRow> = {}): CallRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    conversation_id: "22222222-2222-4222-8222-222222222222",
    caller_owner_id: "google_1",
    callee_owner_id: "google_2",
    media: "audio",
    started_at: STARTED,
    answered_at: null,
    ended_at: null,
    end_reason: null,
    duration_seconds: 0,
    ...overrides,
  };
}

const PROJECTION = {
  callId: "11111111-1111-4111-8111-111111111111",
  conversationId: "22222222-2222-4222-8222-222222222222",
  callerOwnerId: "google_1",
  calleeOwnerId: "google_2" as string | null,
  participantOwnerIds: [] as string[],
  joinedOwnerIds: [] as string[],
  media: "video" as const,
  startedAt: STARTED.toISOString(),
  answeredAt: null,
  endedAt: null,
  endReason: null,
  durationSeconds: 0,
};

describe("projectCall", () => {
  it("upserts by call id so a redelivery changes nothing", async () => {
    const db = mockDb();
    await projectCall(db, PROJECTION);

    expect(sqlOf(db)).toContain("ON CONFLICT (id) DO UPDATE");
  });

  it("fills every column monotonically, so order of arrival cannot regress a row", async () => {
    // A nak requeues one message while the loop moves on, so `ended` can
    // overtake `started`. COALESCE and GREATEST are what make that converge.
    const db = mockDb();
    await projectCall(db, PROJECTION);
    const sql = sqlOf(db);

    expect(sql).toContain("answered_at = COALESCE(calls.answered_at");
    expect(sql).toContain("ended_at = COALESCE(calls.ended_at");
    expect(sql).toContain("end_reason = COALESCE(calls.end_reason");
    expect(sql).toContain("duration_seconds = GREATEST(calls.duration_seconds");
  });

  it("persists the media kind", async () => {
    const db = mockDb();
    await projectCall(db, PROJECTION);

    expect(sqlOf(db)).toContain("media");
    expect(paramsOf(db)).toContain("video");
  });

  it("never updates media on conflict, so the first write wins", async () => {
    // Every event of one call carries the same kind, so a redelivery or an
    // out-of-order `ended` must not be able to flip it.
    const db = mockDb();
    await projectCall(db, PROJECTION);

    const updateClause = sqlOf(db).split("DO UPDATE SET")[1] ?? "";
    expect(updateClause).not.toContain("media");
  });

  it("passes the call id as the primary key, not the conversation", async () => {
    const db = mockDb();
    await projectCall(db, PROJECTION);
    const params = paramsOf(db);
    expect(params[0]).toBe(PROJECTION.callId);
    expect(params[1]).toBe(PROJECTION.conversationId);
  });
});

describe("projectCall — conversation activity", () => {
  /*
   * The bug this pins (dathq, 2026-09-16): "the call in the chat doesn't
   * affect the ordering in the chat list?". `last_activity_at` was never
   * written by anything but the message path, so a call moved a conversation
   * nowhere. Reverting the UPDATE below makes every case here fail.
   */
  it("advances the conversation's activity, so a call moves it up the list", async () => {
    const db = mockDb();
    await projectCall(db, PROJECTION);

    const update = statements(db).find(({ sql }) =>
      sql.startsWith("UPDATE conversations"),
    );
    expect(
      update,
      "the projection never touched the conversation",
    ).toBeDefined();
    expect(update?.sql).toContain("last_activity_at = GREATEST");
    expect(update?.params[0]).toBe(PROJECTION.conversationId);
  });

  it("leaves last_message_at alone, because a call is not a message", async () => {
    const db = mockDb();
    await projectCall(db, PROJECTION);

    const update = statements(db).find(({ sql }) =>
      sql.startsWith("UPDATE conversations"),
    );
    // Asserted as a string so a missing UPDATE fails as a missing UPDATE,
    // rather than as `not.toContain` being handed undefined.
    expect(String(update?.sql)).toContain("last_activity_at");
    expect(String(update?.sql)).not.toContain("last_message_at");
  });

  it("uses the start while a call is still running, so a live call sorts top", async () => {
    const db = mockDb();
    await projectCall(db, { ...PROJECTION, endedAt: null });

    const update = statements(db).find(({ sql }) =>
      sql.startsWith("UPDATE conversations"),
    );
    expect(update?.params[1]).toBe(STARTED.toISOString());
  });

  it("uses the end once there is one: an hour-long call is activity when it finished", async () => {
    const db = mockDb();
    await projectCall(db, {
      ...PROJECTION,
      endedAt: ENDED.toISOString(),
      endReason: "hangup",
      durationSeconds: 185,
    });

    const update = statements(db).find(({ sql }) =>
      sql.startsWith("UPDATE conversations"),
    );
    expect(update?.params[1]).toBe(ENDED.toISOString());
  });

  it("runs inside the call's own transaction, so the two cannot disagree", async () => {
    const db = mockDb();
    await projectCall(db, PROJECTION);

    const mock = db.query as ReturnType<typeof vi.fn>;
    const all = mock.mock.calls.map(([sql]) => String(sql).trim());
    const update = all.findIndex((sql) =>
      sql.startsWith("UPDATE conversations"),
    );
    expect(all[0]).toBe("BEGIN");
    expect(update).toBeGreaterThan(0);
    expect(all.indexOf("COMMIT")).toBeGreaterThan(update);
  });
});

describe("asEndReason", () => {
  it("accepts the reasons the schema allows", () => {
    for (const reason of [
      "hangup",
      "declined",
      "missed",
      "busy",
      "ice_failed",
    ]) {
      expect(asEndReason(reason)).toBe(reason);
    }
  });

  it("rejects anything else, so a producer cannot break the CHECK constraint", () => {
    // The column has a CHECK; an unknown reason must become null rather than
    // fail the insert and cycle through the DLQ.
    for (const reason of ["answered_elsewhere", "", "HANGUP", 7, null]) {
      expect(asEndReason(reason)).toBeNull();
    }
  });
});

describe("callStatus", () => {
  it("derives every state from the stored facts", () => {
    expect(callStatus(row())).toBe("ringing");
    expect(callStatus(row({ answered_at: ANSWERED }))).toBe("active");
    expect(
      callStatus(
        row({ answered_at: ANSWERED, ended_at: ENDED, end_reason: "hangup" }),
      ),
    ).toBe("completed");
    expect(callStatus(row({ ended_at: ENDED, end_reason: "missed" }))).toBe(
      "missed",
    );
    expect(callStatus(row({ ended_at: ENDED, end_reason: "declined" }))).toBe(
      "declined",
    );
  });

  it("treats an unanswered call that ended for any other reason as missed", () => {
    // A caller who cancels while it rings leaves reason `hangup` and no
    // answer — from the callee's side that is still a missed call.
    expect(callStatus(row({ ended_at: ENDED, end_reason: "hangup" }))).toBe(
      "missed",
    );
  });
});

describe("toCall", () => {
  it("serialises timestamps and keeps null for what never happened", () => {
    expect(toCall(row({ ended_at: ENDED, end_reason: "missed" }))).toEqual({
      id: "11111111-1111-4111-8111-111111111111",
      conversationId: "22222222-2222-4222-8222-222222222222",
      callerOwnerId: "google_1",
      calleeOwnerId: "google_2",
      media: "audio",
      status: "missed",
      startedAt: "2026-09-09T10:00:00.000Z",
      answeredAt: null,
      endedAt: "2026-09-09T10:03:05.000Z",
      endReason: "missed",
      durationSeconds: 0,
      // A row projected before phase 3 has no participant rows at all, so both
      // read as empty rather than undefined — the API shape must not change
      // depending on when a call happened.
      participantOwnerIds: [],
      joinedOwnerIds: [],
    });
  });
});

describe("projectCall — participants", () => {
  const GROUP = {
    ...PROJECTION,
    calleeOwnerId: null,
    participantOwnerIds: ["google_1", "google_2", "google_3"],
    joinedOwnerIds: ["google_1", "google_2"],
  };

  it("writes the call and its participants in one transaction", async () => {
    // The foreign key means participants cannot be written first, and a call
    // row without them is a group call that looks like nobody was on it.
    const db = mockDb();
    await projectCall(db, GROUP);

    const mock = db.query as ReturnType<typeof vi.fn>;
    const order = mock.mock.calls.map(
      ([sql]) => String(sql).trim().split(/\s+/)[0],
    );
    expect(order[0]).toBe("BEGIN");
    expect(order.at(-1)).toBe("COMMIT");
    // The call and its participants, in that order. Counted by what they are
    // rather than how many statements the transaction happens to contain —
    // the conversation's activity bump is a third, and unrelated to this rule.
    const written = statements(db).map(({ sql }) => sql);
    expect(written[0]).toContain("INSERT INTO calls");
    expect(written[1]).toContain("INSERT INTO call_participants");
  });

  it("marks who joined, and leaves the rest as merely invited", async () => {
    const db = mockDb();
    await projectCall(db, GROUP);

    const [, participants] = statements(db);
    expect(participants.sql).toContain("INSERT INTO call_participants");
    // The invited set and the joined set travel separately: `joined` is the
    // difference between being rung and being on the call.
    expect(participants.params).toEqual([
      GROUP.callId,
      ["google_1", "google_2", "google_3"],
      ["google_1", "google_2"],
    ]);
  });

  it("only ever flips joined false -> true, so a redelivery cannot un-join anyone", async () => {
    const db = mockDb();
    await projectCall(db, GROUP);

    expect(statements(db)[1].sql).toContain(
      "SET joined = call_participants.joined OR EXCLUDED.joined",
    );
  });

  it("records a joiner the invited list forgot, rather than dropping them", async () => {
    // `joined` is a subset of `participants` by construction: realtime-service
    // refuses a join from anyone outside the invited set. This pins what
    // happens if that ever breaks — the person is kept, because they were on
    // the call, and intersecting against an already-wrong invited list would
    // erase a real participant to satisfy it.
    //
    // It fails if someone "tightens" this by filtering joined against invited.
    const db = mockDb();
    await projectCall(db, {
      ...GROUP,
      participantOwnerIds: ["google_1", "google_2"],
      joinedOwnerIds: ["google_1", "google_2", "google_3"],
    });

    const [, participants] = statements(db);
    expect(participants.params[1]).toEqual(["google_1", "google_2"]);
    // Passed through unfiltered — the union in the statement is what keeps
    // google_3, and `= ANY($3)` is what marks them joined.
    expect(participants.params[2]).toEqual([
      "google_1",
      "google_2",
      "google_3",
    ]);
  });

  it("writes no participant row for a call that carries none", async () => {
    // Every 1:1 event published before the room model. The statement is skipped
    // rather than run with empty arrays, which would be a round trip for nothing.
    const db = mockDb();
    await projectCall(db, PROJECTION);

    expect(
      statements(db).filter(({ sql }) => sql.includes("call_participants")),
    ).toHaveLength(0);
  });

  it("keeps a group call's callee null rather than inventing one", async () => {
    const db = mockDb();
    await projectCall(db, GROUP);

    expect(paramsOf(db)[3]).toBeNull();
    // And a later event must not fill it in: the column is absent from the
    // conflict clause, so the first write wins for good.
    const updateClause = sqlOf(db).split("DO UPDATE")[1];
    expect(updateClause).not.toContain("callee_owner_id");
  });
});

describe("listOwnerCalls", () => {
  it("authorizes by the query itself — either role, nothing else", async () => {
    const db = mockDb([row()]);
    await listOwnerCalls(db, "google_2", 50);

    // No conversation join and no membership lookup: a row is yours only if
    // you were one of the two participants.
    expect(sqlOf(db)).toContain("calls.caller_owner_id = $1");
    expect(sqlOf(db)).toContain("OR calls.callee_owner_id = $1");
    // Group calls are neither role, so membership is the third way in.
    expect(sqlOf(db)).toContain("FROM call_participants cp");
    expect(sqlOf(db)).toContain("ORDER BY calls.started_at DESC");
    expect(paramsOf(db)).toEqual(["google_2", 50]);
  });
});

describe("listConversationCalls", () => {
  it("scopes to the conversation and honours the limit", async () => {
    const db = mockDb([row()]);
    const calls = await listConversationCalls(db, "conv-1", 10);

    expect(sqlOf(db)).toContain("WHERE calls.conversation_id = $1");
    expect(paramsOf(db)).toEqual(["conv-1", 10]);
    expect(calls).toHaveLength(1);
  });
});
