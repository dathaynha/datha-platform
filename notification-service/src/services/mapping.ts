import type { PlatformEvent } from "../types/events";
import type { NotificationSeverity } from "../types/notifications";

export interface NotificationDraft {
  type: string;
  severity: NotificationSeverity;
  titleKey: string;
  bodyKey: string;
  params: Record<string, unknown>;
}

type EventMapper = (envelope: PlatformEvent) => NotificationDraft;

/**
 * Config-driven mapping: envelope `type` → user-facing notification.
 * Unmapped event types are ignored by the consumer (ack, no row).
 * Content is i18n keys + params — rendered strings are never stored
 * (platform/platform-notifications.md).
 */
const EVENT_MAPPINGS: Record<string, EventMapper> = {
  "file.deleted": (envelope) => ({
    type: "file.cleanup",
    severity: "info",
    titleKey: "NOTIFICATIONS.FILE_CLEANUP.TITLE",
    bodyKey: "NOTIFICATIONS.FILE_CLEANUP.BODY",
    params: {
      file_id: envelope.payload.file_id ?? envelope.entity_id,
      mime_type: envelope.payload.mime_type ?? null,
    },
  }),
  /**
   * The only call event that becomes a notification. Ringing rides the socket
   * because it needs sub-second delivery and its own accept/decline UI; a
   * missed call is the one thing left to tell someone about afterwards.
   *
   * realtime-service publishes this one with `owner_id` set to the **callee**,
   * so the bell rings for the person who missed it rather than the caller.
   * Params carry ids only — the conversation is what the UI deep-links to.
   */
  "messenger.call.missed": (envelope) => ({
    type: "call.missed",
    severity: "info",
    titleKey: "NOTIFICATIONS.CALL_MISSED.TITLE",
    bodyKey: "NOTIFICATIONS.CALL_MISSED.BODY",
    params: {
      call_id: envelope.payload.call_id ?? envelope.entity_id,
      conversation_id: envelope.payload.conversation_id ?? null,
      caller_id: envelope.payload.caller_id ?? null,
    },
  }),
};

export function mapEvent(envelope: PlatformEvent): NotificationDraft | null {
  const mapper = EVENT_MAPPINGS[envelope.type];
  return mapper ? mapper(envelope) : null;
}
