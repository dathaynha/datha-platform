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

export interface EventRow {
  id: string;
  type: string;
  service: string;
  entity_id: string | null;
  owner_id: string | null;
  correlation_id: string | null;
  timestamp: Date;
  payload: Record<string, unknown>;
}
