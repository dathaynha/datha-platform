export interface DlqRecord {
  id: string;
  subject: string;
  sink: string;
  originalSubject: string;
  ownerId: string | null;
  correlationId: string | null;
  lastError: string;
  failedAt: string;
  payload: unknown;
  envelope: unknown;
  ingestedAt: string;
  replayedAt: string | null;
  jetstreamStream: string;
  jetstreamSequence: string;
}

export interface DlqListParams {
  sinks?: string[];
  correlationId?: string;
  ownerId?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
  order?: "asc" | "desc";
}

export interface DlqListResponse {
  data: DlqRecord[];
  total: number;
  /**
   * True when `total` is the service's ceiling rather than the real count, so
   * the UI shows "10,000+". An exact `COUNT(*)` reads every matching row; the
   * service counts a capped subquery instead and says when it hit the cap.
   * Optional so a frontend deployed ahead of the service still renders.
   */
  totalCapped?: boolean;
}

export interface DlqReplayResponse {
  id: string;
  originalSubject: string;
  replayedAt: string;
}
