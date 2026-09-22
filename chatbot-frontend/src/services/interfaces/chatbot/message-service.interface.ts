import type {
  MessageCreate,
  MessageJobResponse,
} from "@models/message-job.model";
import type { Observable } from "rxjs";

export interface IMessageService {
  postMessage(body: MessageCreate): Observable<MessageJobResponse>;
}
