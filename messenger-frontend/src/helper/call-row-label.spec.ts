import type { CallRecord } from "src/models/call.model";
import { callDurationLabel, callRowLabel } from "./call-row-label";

/**
 * The wording rule shared by the thread's call rows and the conversation
 * list's preview line. It had no spec of its own until 2026-09-16, which is
 * how a **live** call came to be captioned "Call ended" the day the preview
 * started using it.
 */
function record(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    id: "call-1",
    conversationId: "c1",
    callerOwnerId: "google_me",
    calleeOwnerId: "google_them",
    participantOwnerIds: ["google_me", "google_them"],
    joinedOwnerIds: ["google_me", "google_them"],
    media: "audio",
    status: "completed",
    startedAt: "2026-09-16T10:00:00.000Z",
    answeredAt: "2026-09-16T10:00:04.000Z",
    endedAt: "2026-09-16T10:04:16.000Z",
    endReason: "hangup",
    durationSeconds: 252,
    ...overrides,
  };
}

describe("callRowLabel", () => {
  it("says a call is happening while it is happening", () => {
    // Not "Call ended": a call only reaches a conversation row while it is
    // live, so this is the case the list shows most often.
    expect(callRowLabel(record({ status: "active", endedAt: null })).key).toBe(
      "MESSENGER.CALL.ROW_ONGOING",
    );
  });

  it("says a call is ringing before anybody answers", () => {
    expect(callRowLabel(record({ status: "ringing", endedAt: null })).key).toBe(
      "MESSENGER.CALL.ROW_RINGING",
    );
  });

  it("gives a finished call its kind and its duration", () => {
    const label = callRowLabel(record({ media: "video" }));
    expect(label.key).toBe("MESSENGER.CALL.ROW_VIDEO");
    expect(label.params).toEqual({ duration: "4:12" });
  });

  it("does not claim a duration for a call nobody reported ending", () => {
    /*
     * `expired` is messenger-service's own conclusion that a call outlived any
     * possible call, and its duration is deliberately 0. "· 0:00" would read
     * as a call that connected and lasted no time, which is a different and
     * wrong story.
     */
    const label = callRowLabel(
      record({ endReason: "expired", durationSeconds: 0 }),
    );
    expect(label.key).toBe("MESSENGER.CALL.ROW_ENDED");
    expect(label.params).toBeUndefined();
  });

  it("distinguishes a missed call from a declined one", () => {
    expect(callRowLabel(record({ status: "missed" })).key).toBe(
      "MESSENGER.CALL.ROW_MISSED",
    );
    expect(callRowLabel(record({ status: "declined" })).key).toBe(
      "MESSENGER.CALL.ROW_DECLINED",
    );
  });
});

describe("callDurationLabel", () => {
  it("reads as minutes and seconds, never as a count of seconds", () => {
    expect(callDurationLabel(record({ durationSeconds: 252 }))).toBe("4:12");
    expect(callDurationLabel(record({ durationSeconds: 7 }))).toBe("0:07");
    expect(callDurationLabel(record({ durationSeconds: 60 }))).toBe("1:00");
  });

  it("never renders a negative duration", () => {
    expect(callDurationLabel(record({ durationSeconds: -5 }))).toBe("0:00");
  });
});
