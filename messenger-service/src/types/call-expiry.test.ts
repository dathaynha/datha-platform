import { describe, expect, it } from "vitest";
import { callStatus, settleStaleCall, toCall, type CallRow } from "./messenger";

const HOUR = 60 * 60;

function row(overrides: Partial<CallRow> = {}): CallRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    conversation_id: "22222222-2222-4222-8222-222222222222",
    caller_owner_id: "google_a",
    callee_owner_id: null,
    media: "video",
    started_at: new Date("2026-09-15T10:00:00.000Z"),
    answered_at: new Date("2026-09-15T10:00:05.000Z"),
    ended_at: null,
    end_reason: null,
    duration_seconds: 0,
    participant_owner_ids: ["google_a", "google_b", "google_c"],
    joined_owner_ids: ["google_a", "google_b"],
    ...overrides,
  };
}

/*
 * A call is closed by projecting `call.ended`, published by the process most
 * likely to be the thing that died. When an instance is killed mid-call the
 * event is never published at all, the Redis record expires in silence, and
 * this row claimed a call was in progress forever — so the thread went on
 * offering a Join button for a call that had been over for hours (dathq,
 * 2026-09-15: "the data is wrong when there's a bug happen").
 */
describe("the lifetime bound on an unfinished call", () => {
  const now = new Date("2026-09-15T20:00:00.000Z"); // ten hours later

  it("leaves a call that is genuinely still running alone", () => {
    const fresh = settleStaleCall(
      row({ started_at: new Date("2026-09-15T19:55:00.000Z") }),
      6 * HOUR,
      now,
    );
    expect(fresh.ended_at).toBeNull();
    expect(callStatus(fresh)).toBe("active");
  });

  it("closes one that has outlived any possible call", () => {
    const stale = settleStaleCall(row(), 6 * HOUR, now);

    expect(stale.ended_at).toEqual(new Date("2026-09-15T16:00:00.000Z"));
    expect(stale.end_reason).toBe("expired");
    // Completed, not active: it no longer offers itself as something to join.
    expect(callStatus(stale)).toBe("completed");
  });

  it("does not invent a duration it cannot know", () => {
    // Six hours of "call duration" on a row nobody was on would poison every
    // total built from this column.
    expect(settleStaleCall(row(), 6 * HOUR, now).duration_seconds).toBe(0);
  });

  it("never touches a call that ended properly", () => {
    const ended = row({
      ended_at: new Date("2026-09-15T10:04:12.000Z"),
      end_reason: "hangup",
      duration_seconds: 247,
    });
    expect(settleStaleCall(ended, 6 * HOUR, now)).toBe(ended);
  });

  it("reports the bound through the API shape, not just internally", () => {
    // The banner keys off `endedAt`, so the bound has to reach the wire —
    // a status-only fix would have left the Join button exactly where it was.
    const call = toCall(settleStaleCall(row(), 6 * HOUR, now));
    expect(call.endedAt).toBe("2026-09-15T16:00:00.000Z");
    expect(call.endReason).toBe("expired");
    expect(call.status).toBe("completed");
  });

  it("calls an unanswered stale row missed rather than completed", () => {
    const never = settleStaleCall(row({ answered_at: null }), 6 * HOUR, now);
    expect(callStatus(never)).toBe("missed");
  });
});
