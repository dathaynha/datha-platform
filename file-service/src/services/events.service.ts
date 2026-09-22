import type { JetStreamClient } from "@nats-io/jetstream";
import { v4 as uuidv4 } from "uuid";
import { encodeJsonPayload } from "../nats/encode-payload";
import type { PlatformEvent } from "../types/events";

export interface FileEvent {
  type: "file.uploaded" | "file.deleted";
  fileId: string;
  ownerId: string;
  mimeType: string | null;
  blobPath: string;
  correlationId: string | null;
  /**
   * Which product asked for the file — `chatbot`, `messenger`, …
   *
   * The column has existed since the orphan-reconcile work; what was missing is
   * that it never left this service. The envelope's `service` says
   * `file-service`, which is the publisher, so an audit in the event store
   * could not tell a chatbot attachment from a messenger one without joining
   * back to this database — the one place nobody looks during an incident.
   * Null for rows predating the column.
   */
  origin: string | null;
}

const SUBJECT_BY_TYPE: Record<FileEvent["type"], string> = {
  "file.uploaded": "events.file.file.uploaded",
  "file.deleted": "events.file.file.deleted",
};

function buildEnvelope(event: FileEvent): PlatformEvent {
  return {
    id: uuidv4(),
    type: event.type,
    service: "file-service",
    entity_id: event.fileId,
    owner_id: event.ownerId,
    correlation_id: event.correlationId,
    timestamp: new Date().toISOString(),
    payload: {
      file_id: event.fileId,
      mime_type: event.mimeType,
      blob_path: event.blobPath,
      origin: event.origin,
    },
  };
}

export async function publishEvent(
  js: JetStreamClient | null,
  event: FileEvent,
): Promise<void> {
  if (!js) {
    return;
  }
  const subject = SUBJECT_BY_TYPE[event.type];
  const envelope = buildEnvelope(event);
  await js.publish(subject, encodeJsonPayload(envelope));
}
