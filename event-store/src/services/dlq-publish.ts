import type { JetStreamClient } from "@nats-io/jetstream";
import type { DlqMessageBody } from "../types/dlq";
import { encodeJsonPayload } from "../nats/encode-payload";

export async function publishDlq(
  js: JetStreamClient,
  sink: string,
  record: Omit<DlqMessageBody, "failed_at"> & { failed_at?: string },
): Promise<void> {
  const body: DlqMessageBody = {
    ...record,
    failed_at: record.failed_at ?? new Date().toISOString(),
  };
  await js.publish(`events.dlq.${sink}`, encodeJsonPayload(body));
}
