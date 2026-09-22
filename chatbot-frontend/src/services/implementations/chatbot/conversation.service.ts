import { HttpClient, HttpParams } from "@angular/common/http";
import { Injectable } from "@angular/core";
import type {
  ConversationSummaryDto,
  ConversationTitleDto,
  HistoryMessagesPageDto,
} from "@models/chat-history.model";
import type {
  ActiveJobDto,
  MessageJobResponse,
} from "@models/message-job.model";
import type { IConversationService } from "@services/interfaces/chatbot/conversation-service.interface";
import { map, Observable } from "rxjs";
import { THREAD_MESSAGE_PAGE_SIZE } from "@constants/chat-page.constant";

import { chatbotGatewayBase } from "./chatbot-gateway-base";

@Injectable()
export class ConversationService implements IConversationService {
  constructor(private readonly http: HttpClient) {}

  list(limit = 40, offset = 0): Observable<readonly ConversationSummaryDto[]> {
    const url = `${chatbotGatewayBase()}/conversations`;
    const params = new HttpParams()
      .set("limit", String(limit))
      .set("offset", String(offset));
    return this.http.get<ConversationSummaryDto[]>(url, { params });
  }

  activeJob(conversationId: string): Observable<ActiveJobDto | null> {
    const url = `${chatbotGatewayBase()}/conversations/${encodeURIComponent(conversationId)}/active-job`;
    // 204 (nothing generating) arrives as a null body.
    return this.http
      .get<ActiveJobDto | null>(url)
      .pipe(map((job) => (job && job.job_id ? job : null)));
  }

  retryLast(
    conversationId: string,
    model?: string,
  ): Observable<MessageJobResponse> {
    const url = `${chatbotGatewayBase()}/conversations/${encodeURIComponent(conversationId)}/retry-last`;
    // The gateway injects stream_token into this response, as it does for POST /messages.
    return this.http.post<MessageJobResponse>(url, { model: model ?? "" });
  }

  listMessages(
    conversationId: string,
    options?: { limit?: number; beforeId?: string },
  ): Observable<HistoryMessagesPageDto> {
    const url = `${chatbotGatewayBase()}/conversations/${encodeURIComponent(conversationId)}/messages`;
    let params = new HttpParams().set(
      "limit",
      String(options?.limit ?? THREAD_MESSAGE_PAGE_SIZE),
    );
    if (options?.beforeId) {
      params = params.set("before_id", options.beforeId);
    }
    return this.http.get<HistoryMessagesPageDto>(url, { params });
  }

  patchTitle(
    conversationId: string,
    title: string,
  ): Observable<ConversationTitleDto> {
    const url = `${chatbotGatewayBase()}/conversations/${encodeURIComponent(conversationId)}`;
    return this.http.patch<ConversationTitleDto>(url, { title });
  }

  delete(conversationId: string): Observable<void> {
    const url = `${chatbotGatewayBase()}/conversations/${encodeURIComponent(conversationId)}`;
    return this.http.delete<void>(url);
  }
}
