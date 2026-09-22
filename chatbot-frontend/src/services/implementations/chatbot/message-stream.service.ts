import { Injectable } from "@angular/core";
import type { MessageStreamEvent } from "@models/message-job.model";
import type { IMessageStreamService } from "@services/interfaces/chatbot/message-stream-service.interface";
import { Observable, timeout } from "rxjs";

import { chatbotGatewayBase } from "./chatbot-gateway-base";

/** No first event (worker claim) within this window → worker down or queue stuck. */
const FIRST_EVENT_TIMEOUT_MS = 30_000;
/** No follow-up event within this window → generation stalled mid-stream. */
const IDLE_EVENT_TIMEOUT_MS = 90_000;

@Injectable()
export class MessageStreamService implements IMessageStreamService {
  openStream(
    jobId: string,
    streamToken: string,
  ): Observable<MessageStreamEvent> {
    const url = `${chatbotGatewayBase()}/stream/${encodeURIComponent(jobId)}?stream_token=${encodeURIComponent(streamToken)}`;
    // SSE keepalive comments do not fire onmessage, so these timeouts only
    // reset on real events (claimed/chunk/done/error) — a silently dead
    // backend cannot keep the spinner alive forever.
    return new Observable<MessageStreamEvent>((subscriber) => {
      const es = new EventSource(url);
      let endedNormally = false;

      es.onmessage = (evt: MessageEvent<string>) => {
        let parsed: MessageStreamEvent;
        try {
          parsed = JSON.parse(evt.data) as MessageStreamEvent;
        } catch {
          if (!subscriber.closed) {
            subscriber.error(new Error("Invalid SSE payload"));
          }
          es.close();
          return;
        }
        subscriber.next(parsed);
        if (parsed.type === "done" || parsed.type === "error") {
          endedNormally = true;
          subscriber.complete();
          es.close();
        }
      };

      es.onerror = () => {
        es.close();
        if (endedNormally || subscriber.closed) {
          return;
        }
        subscriber.error(new Error("SSE connection error"));
      };

      return () => {
        endedNormally = true;
        es.close();
      };
    }).pipe(
      timeout({ first: FIRST_EVENT_TIMEOUT_MS, each: IDLE_EVENT_TIMEOUT_MS }),
    );
  }
}
