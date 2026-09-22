import { HttpClient } from "@angular/common/http";
import { Injectable } from "@angular/core";
import type {
  MessageCreate,
  MessageJobResponse,
} from "@models/message-job.model";
import type { IMessageService } from "@services/interfaces/chatbot/message-service.interface";
import { Observable } from "rxjs";
import { DEFAULT_CHAT_MODEL_ID } from "@constants/chat-page.constant";

import { chatbotGatewayBase } from "./chatbot-gateway-base";

@Injectable()
export class MessageService implements IMessageService {
  constructor(private readonly http: HttpClient) {}

  postMessage(body: MessageCreate): Observable<MessageJobResponse> {
    const url = `${chatbotGatewayBase()}/messages`;
    const files = body.files ?? [];
    return this.http.post<MessageJobResponse>(url, {
      text: body.text,
      conversation_id: body.conversation_id ?? null,
      model: body.model ?? DEFAULT_CHAT_MODEL_ID,
      files: files.map((f) => ({
        file_id: f.file_id,
        name: f.name,
        mime_type: f.mime_type ?? null,
      })),
    });
  }
}
