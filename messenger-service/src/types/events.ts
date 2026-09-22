/** Standard platform event envelope (platform/event-store-architecture.md). */
export interface PlatformEvent {
  id: string;
  type: string;
  service: string;
  entity_id: string | null;
  owner_id: string | null;
  correlation_id: string | null;
  timestamp: string;
  payload: Record<string, unknown>;
}

/** Live frame pushed to core NATS `rt.owner.<owner_id>` for realtime-service. */
export interface RealtimeFrame {
  t:
    | "message.new"
    | "unread.added"
    | "unread.cleared"
    | "receipt.read"
    | "conversation.created";
  d: Record<string, unknown>;
}
