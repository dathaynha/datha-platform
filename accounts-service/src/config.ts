import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().default(3006),
  DATABASE_URL: z.string().min(1),
  /**
   * Phase 0 directory model: every signed-in user joins one shared workspace,
   * so people can actually find each other. The schema stays multi-tenant —
   * splitting into real tenants later is data, not a migration of shape.
   */
  DEFAULT_WORKSPACE_SLUG: z.string().min(1).default("datha-platform"),
  DEFAULT_WORKSPACE_NAME: z.string().min(1).default("DatHa Platform"),
  DIRECTORY_MAX_RESULTS: z.coerce.number().int().min(1).max(100).default(25),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
