/**
 * Reconcile JetStream streams and durable consumers (add or update).
 * Run after NATS is up, before event-store / file-service / chatbot-service.
 */
import "dotenv/config";
import { connect } from "@nats-io/transport-node";
import {
  jetstreamManager,
  type ConsumerConfig,
  type JetStreamManager,
  type StreamConfig,
} from "@nats-io/jetstream";
import { platformMaxDeliver } from "./max-deliver";
import {
  STREAM_DLQ,
  STREAM_EVENTS,
  dlqStreamConfig,
  eventStoreDlqIngestConsumer,
  eventStoreIngestConsumer,
  eventsStreamConfig,
  fileConversationCleanupConsumer,
  messengerCallsConsumer,
  notificationDlqConsumer,
  notificationEventsConsumer,
} from "./topology";

const NATS_URL = process.env.NATS_URL ?? "nats://localhost:4222";

async function reconcileStream(
  jsm: JetStreamManager,
  config: Partial<StreamConfig> & { name: string },
): Promise<void> {
  const name = config.name;
  try {
    await jsm.streams.info(name);
    await jsm.streams.update(name, config);
    console.log(`[jetstream] stream updated: ${name}`);
  } catch {
    await jsm.streams.add(config);
    console.log(`[jetstream] stream created: ${name}`);
  }
}

async function reconcileConsumer(
  jsm: JetStreamManager,
  stream: string,
  config: Partial<ConsumerConfig>,
): Promise<void> {
  const durable = config.durable_name!;
  try {
    await jsm.consumers.info(stream, durable);
    try {
      await jsm.consumers.update(stream, durable, config);
      console.log(
        `[jetstream] consumer updated: ${stream}/${durable} (max_deliver=${config.max_deliver})`,
      );
    } catch (err) {
      console.warn(
        `[jetstream] consumer ${stream}/${durable} exists but update failed — ` +
          "delete the durable manually if you changed filter_subject or max_deliver:",
        err,
      );
    }
  } catch {
    await jsm.consumers.add(stream, config);
    console.log(
      `[jetstream] consumer created: ${stream}/${durable} (max_deliver=${config.max_deliver})`,
    );
  }
}

async function main() {
  platformMaxDeliver(); // validate platform default early

  const nc = await connect({ servers: NATS_URL });
  const jsm = await jetstreamManager(nc);

  try {
    await reconcileStream(jsm, eventsStreamConfig());
    await reconcileStream(jsm, dlqStreamConfig());

    await reconcileConsumer(
      jsm,
      STREAM_EVENTS,
      fileConversationCleanupConsumer(),
    );
    await reconcileConsumer(jsm, STREAM_EVENTS, eventStoreIngestConsumer());
    await reconcileConsumer(jsm, STREAM_DLQ, eventStoreDlqIngestConsumer());
    await reconcileConsumer(jsm, STREAM_EVENTS, notificationEventsConsumer());
    await reconcileConsumer(jsm, STREAM_DLQ, notificationDlqConsumer());
    await reconcileConsumer(jsm, STREAM_EVENTS, messengerCallsConsumer());

    console.log("[jetstream] reconcile done");
  } finally {
    await nc.drain();
  }
}

main().catch((err) => {
  console.error("[jetstream] reconcile failed:", err);
  process.exit(1);
});
