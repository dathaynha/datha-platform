process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://localhost/event_store_test";
process.env.NATS_CONSUMER_MAX_DELIVER_EVENT_STORE_INGEST =
  process.env.NATS_CONSUMER_MAX_DELIVER_EVENT_STORE_INGEST ?? "3";
