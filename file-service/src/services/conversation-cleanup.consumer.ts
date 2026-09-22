import type { FastifyInstance } from "fastify";
import type { JsMsg, JetStreamClient } from "@nats-io/jetstream";
import { Pool } from "pg";
import { createSasService } from "./sas.service";
import * as fileService from "./file.service";
import { publishEvent } from "./events.service";
import { publishDlq } from "./dlq.service";
import {
  CONSUMER_CONVERSATION_CLEANUP,
  DLQ_SINK_CONVERSATION_CLEANUP,
  STREAM_EVENTS,
} from "../nats/streams";
import type {
  ConversationDeletedPayload,
  PlatformEvent,
} from "../types/events";
import { config } from "../config";

/** App DLQ threshold — broker `max_deliver` for same durable is set in platform-nats reconcile. */
const MAX_DELIVER =
  config.NATS_CONSUMER_MAX_DELIVER_FILE_SERVICE_CONVERSATION_CLEANUP;

function parseEnvelope(data: Uint8Array): PlatformEvent {
  const raw = JSON.parse(new TextDecoder().decode(data)) as PlatformEvent;
  if (!raw || typeof raw !== "object" || !raw.payload) {
    throw new Error("invalid event envelope");
  }
  return raw;
}

function isNotFound(err: unknown): boolean {
  return (err as { statusCode?: number }).statusCode === 404;
}

function isForbidden(err: unknown): boolean {
  return (err as { statusCode?: number }).statusCode === 403;
}

async function processConversationDeleted(
  fastify: FastifyInstance,
  js: JetStreamClient,
  db: Pool,
  envelope: PlatformEvent,
  log: FastifyInstance["log"],
): Promise<void> {
  const payload = envelope.payload as unknown as ConversationDeletedPayload;
  const fileIds = Array.isArray(payload.file_ids) ? payload.file_ids : [];
  const ownerId = envelope.owner_id;
  if (!ownerId) {
    throw new Error("envelope missing owner_id");
  }

  const sas = createSasService(fastify.blobServiceClient);

  for (const fileId of fileIds) {
    if (!fileId || typeof fileId !== "string") continue;
    try {
      const file = await fileService.softDeleteFile(
        db,
        fileId,
        ownerId,
        sas.deleteBlob,
      );
      await publishEvent(js, {
        type: "file.deleted",
        fileId: file.id,
        ownerId: file.owner_id,
        mimeType: file.mime_type,
        blobPath: file.blob_path,
        correlationId: envelope.correlation_id,
        origin: file.origin,
      }).catch((err) =>
        log.error({ err, fileId }, "Failed to publish file.deleted event"),
      );
    } catch (err) {
      if (isNotFound(err)) {
        log.info(
          { fileId, ownerId },
          "file already deleted or missing; skipping",
        );
        continue;
      }
      if (isForbidden(err)) {
        log.warn({ fileId, ownerId }, "file ownership mismatch; skipping");
        continue;
      }
      throw err;
    }
  }
}

async function handleMessage(
  fastify: FastifyInstance,
  js: JetStreamClient,
  msg: JsMsg,
): Promise<void> {
  const log = fastify.log;
  let envelope: PlatformEvent;
  try {
    envelope = parseEnvelope(msg.data);
  } catch (err) {
    log.error({ err }, "invalid conversation.deleted message");
    msg.ack();
    return;
  }

  try {
    await processConversationDeleted(fastify, js, fastify.db, envelope, log);
    msg.ack();
  } catch (err) {
    const deliveryCount = msg.info?.deliveryCount ?? 1;
    const lastError = err instanceof Error ? err.message : String(err);
    log.error(
      { err, deliveryCount, subject: msg.subject },
      "conversation cleanup failed",
    );

    if (deliveryCount >= MAX_DELIVER) {
      await publishDlq(js, DLQ_SINK_CONVERSATION_CLEANUP, {
        original_subject: msg.subject,
        correlation_id: envelope.correlation_id,
        owner_id: envelope.owner_id,
        payload: envelope.payload,
        last_error: lastError,
        envelope,
      });
      msg.ack();
      return;
    }
    msg.nak();
  }
}

/** Pull-loop consumer for events.chatbot.conversation.deleted (see platform/chatbot-file-events.md). */
export { parseEnvelope, processConversationDeleted, handleMessage };

export function startConversationCleanupConsumer(
  fastify: FastifyInstance,
): void {
  const js = fastify.js;
  if (!js) {
    return;
  }
  let stopped = false;

  fastify.addHook("onClose", async () => {
    stopped = true;
  });

  const run = async () => {
    let consumer:
      Awaited<ReturnType<JetStreamClient["consumers"]["get"]>> | undefined;
    while (!stopped && !consumer) {
      try {
        consumer = await js.consumers.get(
          STREAM_EVENTS,
          CONSUMER_CONVERSATION_CLEANUP,
        );
      } catch (err) {
        if (stopped) return;
        fastify.log.warn(
          { err },
          "conversation cleanup consumer not ready; retrying",
        );
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    if (!consumer) return;

    fastify.log.info("conversation cleanup JetStream consumer started");

    while (!stopped) {
      try {
        const batch = await consumer.fetch({
          max_messages: 5,
          expires: 30_000,
        });
        for await (const msg of batch) {
          if (stopped) {
            msg.nak();
            break;
          }
          await handleMessage(fastify, js, msg);
        }
      } catch (err) {
        if (stopped) break;
        fastify.log.error({ err }, "conversation cleanup fetch error");
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  };

  run().catch((err) =>
    fastify.log.error({ err }, "conversation cleanup consumer crashed"),
  );
}
