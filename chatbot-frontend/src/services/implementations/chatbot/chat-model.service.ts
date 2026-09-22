import { HttpClient } from "@angular/common/http";
import { Injectable } from "@angular/core";
import type { ChatModelsResponseDto } from "@models/chat-model.model";
import type { IChatModelService } from "@services/interfaces/chatbot/chat-model-service.interface";
import { Observable } from "rxjs";

import { chatbotGatewayBase } from "./chatbot-gateway-base";

@Injectable()
export class ChatModelService implements IChatModelService {
  constructor(private readonly http: HttpClient) {}

  listModels(): Observable<ChatModelsResponseDto> {
    const url = `${chatbotGatewayBase()}/models`;
    return this.http.get<ChatModelsResponseDto>(url);
  }
}
