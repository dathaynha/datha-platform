import { InjectionToken } from "@angular/core";
import type { IChatModelService } from "@services/interfaces/chatbot/chat-model-service.interface";
import type { IConversationService } from "@services/interfaces/chatbot/conversation-service.interface";
import type { IMessageStreamService } from "@services/interfaces/chatbot/message-stream-service.interface";
import type { IMessageService } from "@services/interfaces/chatbot/message-service.interface";
import type { IFileService } from "@services/interfaces/file-service/file-service.interface";

export const MESSAGE_SERVICE_INJECTOR = new InjectionToken<IMessageService>(
  "MESSAGE_SERVICE_INJECTOR",
);

export const MESSAGE_STREAM_SERVICE_INJECTOR =
  new InjectionToken<IMessageStreamService>("MESSAGE_STREAM_SERVICE_INJECTOR");

export const CONVERSATION_SERVICE_INJECTOR =
  new InjectionToken<IConversationService>("CONVERSATION_SERVICE_INJECTOR");

export const CHAT_MODEL_SERVICE_INJECTOR =
  new InjectionToken<IChatModelService>("CHAT_MODEL_SERVICE_INJECTOR");

/** Provide with `{ provide: FILE_SERVICE_INJECTOR, useClass: FileService }` where uploads are needed. */
export const FILE_SERVICE_INJECTOR = new InjectionToken<IFileService>(
  "FILE_SERVICE_INJECTOR",
);
