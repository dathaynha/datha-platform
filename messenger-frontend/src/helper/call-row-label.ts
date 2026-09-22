import type { CallRecord } from "src/models/call.model";

/** A translation key and the parameters it interpolates. */
export interface CallLabel {
  key: string;
  params?: Record<string, string>;
}

/** `m:ss`, from a duration the server counted in whole seconds. */
export function callDurationLabel(record: CallRecord): string {
  const total = Math.max(0, record.durationSeconds);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * What a call row says — for the thread's timeline **and** the conversation
 * list's preview line.
 *
 * Shared deliberately. The rule lived only in `thread.component.html`, and the
 * list needed the same sentence the moment a call started moving conversations
 * up the list (2026-09-16). Two copies of a status-to-wording mapping is the
 * kind of duplication that drifts silently: the `expired` case below took a
 * bug report to get right once already, and nobody would have thought to fix
 * it twice.
 */
export function callRowLabel(record: CallRecord): CallLabel {
  switch (record.status) {
    /*
     * A call that has not ended yet. Both used to fall through to the default
     * and read "Call ended", which is the opposite of true — introduced with
     * the preview line on 2026-09-16 and caught the same day, because a call
     * only reaches a conversation row while it is *happening*.
     */
    case "active":
      return { key: "MESSENGER.CALL.ROW_ONGOING" };
    case "ringing":
      return { key: "MESSENGER.CALL.ROW_RINGING" };
    case "completed":
      /*
       * Nobody ever reported this call ending, so a time bound closed it and
       * its duration is deliberately 0. Rendering "· 0:00" would read as a
       * call that connected and lasted no time, which is a different and wrong
       * story.
       */
      if (record.endReason === "expired") {
        return { key: "MESSENGER.CALL.ROW_ENDED" };
      }
      return {
        key:
          record.media === "video"
            ? "MESSENGER.CALL.ROW_VIDEO"
            : "MESSENGER.CALL.ROW_AUDIO",
        params: { duration: callDurationLabel(record) },
      };
    case "missed":
      return { key: "MESSENGER.CALL.ROW_MISSED" };
    case "declined":
      return { key: "MESSENGER.CALL.ROW_DECLINED" };
    default:
      return { key: "MESSENGER.CALL.ROW_ENDED" };
  }
}
