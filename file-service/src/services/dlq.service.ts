import type { JetStreamClient } from "@nats-io/jetstream";
import { encodeJsonPayload } from "../nats/encode-payload";
import type { DlqRecord } from "../types/events";

export async function publishDlq(
  js: JetStreamClient,
  sink: string,
  record: Omit<DlqRecord, "failed_at"> & { failed_at?: string },
): Promise<void> {
  const body: DlqRecord = {
    ...record,
    failed_at: record.failed_at ?? new Date().toISOString(),
  };
  await js.publish(`events.dlq.${sink}`, encodeJsonPayload(body));
}
