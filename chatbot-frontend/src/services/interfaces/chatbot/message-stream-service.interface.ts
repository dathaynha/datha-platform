import type { MessageStreamEvent } from "@models/message-job.model";
import type { Observable } from "rxjs";

export interface IMessageStreamService {
  openStream(
    jobId: string,
    streamToken: string,
  ): Observable<MessageStreamEvent>;
}
