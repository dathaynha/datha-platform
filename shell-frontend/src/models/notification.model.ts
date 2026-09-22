export type NotificationSeverity = "info" | "warning" | "critical";

/** Notification projected by notification-service — i18n keys + params, rendered client-side. */
export interface PlatformNotification {
  id: string;
  type: string;
  severity: NotificationSeverity;
  sourceService: string;
  titleKey: string;
  bodyKey: string;
  params: Record<string, unknown>;
  /** In-app route to navigate to on click (null = informational only). */
  link: string | null;
  correlationId: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationListResponse {
  data: PlatformNotification[];
}

export interface UnreadCountResponse {
  count: number;
}

/** Short-lived token minted by the gateway — authorises the SSE stream (EventSource cannot send headers). */
export interface NotificationStreamTokenResponse {
  stream_token: string;
}

/** Per-owner channel gating — the in-app drawer is never gated. Absent row server-side = these defaults. */
export interface NotificationPreferences {
  locale: string;
  pushEnabled: boolean;
  pushMinSeverity: NotificationSeverity;
  emailDigest: boolean;
}
