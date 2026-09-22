import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().default(3002),
  DATABASE_URL: z.string().min(1),
  NATS_URL: z.string().min(1).default("nats://localhost:4222"),
  /** Pull consumer fetch batch size. */
  NATS_INGEST_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(25),
  /**
   * EVENTS ingest: delivery attempts before DLQ + ack.
   * Must match platform-nats reconcile for durable `event-store-ingest`.
   */
  NATS_CONSUMER_MAX_DELIVER_EVENT_STORE_INGEST: z.coerce
    .number()
    .int()
    .min(1)
    .default(3),
  /**
   * Upper bound on the `total` an ops list reports.
   *
   * An exact `COUNT(*)` reads every matching row, so an unfiltered list gets
   * slower forever as the store grows. Counting a capped subquery reads at most
   * this many rows whatever the table holds, and the response says when it hit
   * the ceiling so the UI can render "10,000+" instead of a wrong number.
   */
  LIST_COUNT_CAP: z.coerce
    .number()
    .int()
    .min(100)
    .max(1_000_000)
    .default(10_000),
  /** Postgres events rows older than this are retention candidates (see `pnpm retain`). */
  EVENTS_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
  /** Postgres dlq_records rows older than this (by failed_at) are retention candidates. */
  DLQ_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(180),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
