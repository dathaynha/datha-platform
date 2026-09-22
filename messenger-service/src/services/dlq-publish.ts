import type { JetStreamPublisher } from "./publish";
import { dlqSubject } from "../nats/streams";
import { encodeJsonPayload } from "../nats/encode-payload";
import type { DlqMessageBody } from "../types/dlq";

/** Publishes a give-up record so event-store persists it for replay. */
export async function publishDlq(
  js: JetStreamPublisher,
  sink: string,
  record: Omit<DlqMessageBody, "failed_at"> & { failed_at?: string },
): Promise<void> {
  const body: DlqMessageBody = {
    ...record,
    failed_at: record.failed_at ?? new Date().toISOString(),
  };
  await js.publish(dlqSubject(sink), encodeJsonPayload(body));
}
