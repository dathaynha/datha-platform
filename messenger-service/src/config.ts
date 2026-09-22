import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().default(3005),
  DATABASE_URL: z.string().min(1),
  NATS_URL: z.string().min(1).default("nats://localhost:4222"),
  /**
   * Phase 1 runs the single shared workspace accounts-service provisions, so
   * the tenant is config rather than a lookup. The column exists either way —
   * real tenants later are data, not a change of shape.
   */
  DEFAULT_TENANT_ID: z.string().min(1).default("datha-platform"),
  CONVERSATIONS_PAGE_SIZE: z.coerce.number().int().min(1).max(100).default(30),
  MESSAGES_PAGE_SIZE: z.coerce.number().int().min(1).max(200).default(50),
  /**
   * How many people a group may hold.
   *
   * A **product** limit, not a technical one, and deliberately not the same
   * number as realtime-service's `MAX_CALL_PARTICIPANTS` (4): a mesh call is
   * peer-to-peer and costs the platform nothing, while a group chat is useful
   * at sizes calling never reaches. WhatsApp and Messenger keep the two apart
   * for the same reason.
   *
   * Lowered from 50 on 2026-09-16 (dathq) while the platform is unpaid. It is
   * env-driven precisely so raising it later needs no code — and 5 was
   * rejected on purpose: one more than the call cap makes every group look
   * callable and fail by exactly one person.
   */
  MAX_GROUP_PARTICIPANTS: z.coerce.number().int().min(2).max(500).default(10),
  /**
   * file-service, for attachment download URLs. A private-network call: the
   * reader is authorized here (conversation membership) and file-service is
   * asked as the uploader, since it scopes every query by owner.
   */
  FILE_SERVICE_URL: z.string().min(1).default("http://localhost:3001"),
  /**
   * Call-history projection: delivery attempts before the DLQ publish + ack.
   * Must match platform-nats reconcile for durable `messenger-service-calls`.
   */
  NATS_CONSUMER_MAX_DELIVER_MESSENGER_SERVICE_CALLS: z.coerce
    .number()
    .int()
    .min(1)
    .default(3),
  CALLS_PAGE_SIZE: z.coerce.number().int().min(1).max(200).default(50),
  /**
   * How long a call may stay unfinished before this service stops believing it.
   *
   * `ended_at` is written only by the projection of a `call.ended` event, so a
   * call whose event never arrives stays "in progress" forever — and every
   * reader, including the thread's ongoing-call banner, believes it. This is
   * the time bound that makes that impossible.
   *
   * **Must be at least realtime-service's `CALL_TTL_SECONDS`** (4 h by
   * default), which is the longest a call can legitimately live. Shorter and
   * this service would declare a real call over while people are still on it.
   */
  CALL_MAX_LIFETIME_SECONDS: z.coerce
    .number()
    .int()
    .min(600)
    .default(6 * 60 * 60),
  /** How often unfinished calls past that bound are closed for good. */
  CALL_SWEEP_INTERVAL_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .default(15 * 60),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
