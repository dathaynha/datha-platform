import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().default(3001),
  DATABASE_URL: z.string().min(1),
  AZURE_STORAGE_ACCOUNT: z.string().min(1),
  AZURE_STORAGE_CONTAINER: z.string().min(1),
  AZURE_STORAGE_CONNECTION_STRING: z.string().min(1),
  SAS_UPLOAD_TTL_SECONDS: z.coerce.number().default(300),
  /** Max uploaded blob size for chat attachments (must align with chatbot-service worker). */
  MAX_UPLOAD_BYTES: z.coerce.number().default(20 * 1024 * 1024),
  /** Read SAS for previews/downloads — keep short to limit leaked-link exposure (override via env). */
  SAS_DOWNLOAD_TTL_SECONDS: z.coerce.number().default(900),
  NATS_URL: z.string().min(1).default("nats://localhost:4222"),
  /**
   * JetStream delivery attempts for `events.chatbot.conversation.deleted` before app DLQ + ack.
   * Must match platform-nats reconcile for durable `file-service-conversation-cleanup`.
   */
  NATS_CONSUMER_MAX_DELIVER_FILE_SERVICE_CONVERSATION_CLEANUP: z.coerce
    .number()
    .int()
    .min(1)
    .default(3),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
