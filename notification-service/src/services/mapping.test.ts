import { describe, expect, it } from "vitest";
import type { PlatformEvent } from "../types/events";
import { mapEvent } from "./mapping";

function envelope(overrides: Partial<PlatformEvent> = {}): PlatformEvent {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    type: "file.deleted",
    service: "file-service",
    entity_id: "file-1",
    owner_id: "google_owner",
    correlation_id: "corr-1",
    timestamp: "2026-01-01T00:00:00.000Z",
    payload: { file_id: "file-1", mime_type: "image/png" },
    ...overrides,
  };
}

describe("mapEvent", () => {
  it("maps file.deleted to a file.cleanup draft with i18n keys", () => {
    const draft = mapEvent(envelope());
    expect(draft).toEqual({
      type: "file.cleanup",
      severity: "info",
      titleKey: "NOTIFICATIONS.FILE_CLEANUP.TITLE",
      bodyKey: "NOTIFICATIONS.FILE_CLEANUP.BODY",
      params: { file_id: "file-1", mime_type: "image/png" },
    });
  });

  it("falls back to entity_id when payload.file_id is missing (schema tolerance)", () => {
    const draft = mapEvent(envelope({ payload: { unknown_field: true } }));
    expect(draft?.params).toEqual({ file_id: "file-1", mime_type: null });
  });

  it("maps messenger.call.missed to a call.missed draft", () => {
    const draft = mapEvent(
      envelope({
        type: "messenger.call.missed",
        service: "realtime-service",
        entity_id: "call-1",
        // realtime-service attributes a missed call to the callee, so this is
        // already the person whose bell should ring.
        owner_id: "google_callee",
        payload: {
          call_id: "call-1",
          conversation_id: "conv-1",
          caller_id: "google_caller",
          reason: "missed",
        },
      }),
    );
    expect(draft).toEqual({
      type: "call.missed",
      severity: "info",
      titleKey: "NOTIFICATIONS.CALL_MISSED.TITLE",
      bodyKey: "NOTIFICATIONS.CALL_MISSED.BODY",
      params: {
        call_id: "call-1",
        conversation_id: "conv-1",
        caller_id: "google_caller",
      },
    });
  });

  it("does not notify on a call that connected", () => {
    // Only the missed one crosses into the bell; started and ended are history
    // rows, and ringing itself rides the socket.
    for (const type of ["messenger.call.started", "messenger.call.ended"]) {
      expect(mapEvent(envelope({ type }))).toBeNull();
    }
  });

  it("returns null for unmapped event types", () => {
    expect(mapEvent(envelope({ type: "message.sent" }))).toBeNull();
    expect(mapEvent(envelope({ type: "conversation.deleted" }))).toBeNull();
  });
});
