import type { ChatModelsResponseDto } from "@models/chat-model.model";
import type { Observable } from "rxjs";

export interface IChatModelService {
  listModels(): Observable<ChatModelsResponseDto>;
}
