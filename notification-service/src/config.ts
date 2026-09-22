import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().default(3003),
  DATABASE_URL: z.string().min(1),
  NATS_URL: z.string().min(1).default("nats://localhost:4222"),
  /** Pull consumer fetch batch size. */
  NATS_INGEST_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(25),
  /**
   * EVENTS projection: delivery attempts before DLQ + ack.
   * Must match platform-nats reconcile for durable `notification-service-events`.
   */
  NATS_CONSUMER_MAX_DELIVER_NOTIFICATION_SERVICE_EVENTS: z.coerce
    .number()
    .int()
    .min(1)
    .default(3),
  /** Read notifications older than this are purged by the in-app sweep. */
  NOTIFICATIONS_READ_RETENTION_DAYS: z.coerce
    .number()
    .int()
    .min(1)
    .max(3650)
    .default(30),
  /** Web Push VAPID keys — push sending is disabled (warn) when unset. */
  VAPID_PUBLIC_KEY: z.string().default(""),
  VAPID_PRIVATE_KEY: z.string().default(""),
  VAPID_SUBJECT: z.string().default("mailto:dathaynha@gmail.com"),
  /** SMTP transport — email digest is disabled (warn) when SMTP_HOST unset. */
  SMTP_HOST: z.string().default(""),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(1025),
  SMTP_SECURE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  SMTP_USER: z.string().default(""),
  SMTP_PASS: z.string().default(""),
  SMTP_FROM: z.string().default("DatHa Platform <noreply@datha.local>"),
  /** Minimum hours between digest emails per owner (daily cadence). */
  NOTIFICATIONS_DIGEST_MIN_INTERVAL_HOURS: z.coerce
    .number()
    .int()
    .min(1)
    .default(24),
  /** Shell base URL — i18n catalog source for send-time rendering + digest links. */
  SHELL_PUBLIC_URL: z.string().default("http://localhost:4000"),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
