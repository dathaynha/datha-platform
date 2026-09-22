import type {
  ConversationSummaryDto,
  ConversationTitleDto,
  HistoryMessagesPageDto,
} from "@models/chat-history.model";
import type {
  ActiveJobDto,
  MessageJobResponse,
} from "@models/message-job.model";
import type { Observable } from "rxjs";

export interface IConversationService {
  list(
    limit?: number,
    offset?: number,
  ): Observable<readonly ConversationSummaryDto[]>;

  /** Emits the running job for this thread, or `null` when nothing is generating. */
  activeJob(conversationId: string): Observable<ActiveJobDto | null>;

  /**
   * Re-runs generation for the last user turn (no second user message). 409 while a
   * job is still running, 404 when the last turn is not a failed reply.
   */
  retryLast(
    conversationId: string,
    model?: string,
  ): Observable<MessageJobResponse>;

  listMessages(
    conversationId: string,
    options?: { limit?: number; beforeId?: string },
  ): Observable<HistoryMessagesPageDto>;

  patchTitle(
    conversationId: string,
    title: string,
  ): Observable<ConversationTitleDto>;

  delete(conversationId: string): Observable<void>;
}
