/**
 * Manual Postgres retention for events + DLQ rows. Default dry-run; pass --execute to DELETE.
 *
 *   pnpm retain           # dry-run
 *   pnpm retain --execute # delete rows older than configured TTL
 *
 * Prod: ADO scheduled job (~daily) with the same --execute command.
 * Does not require the HTTP server to be running.
 */
import "dotenv/config";
import { Pool } from "pg";
import { config } from "./config";
import { ensureEventsPartitions } from "./services/partitions";
import { runRetention } from "./services/retention";

function parseExecute(argv: string[]): boolean {
  return argv.includes("--execute");
}

async function main(): Promise<number> {
  const execute = parseExecute(process.argv.slice(2));
  if (!execute) {
    console.log("[retain] dry-run mode (pass --execute to delete)");
  }

  const pool = new Pool({ connectionString: config.DATABASE_URL });
  try {
    // The forward window, kept open by the job that runs daily rather than only
    // by a service restart. Runs in dry-run too: creating an empty partition
    // deletes nothing, and skipping it here would mean the one command that
    // runs every day is also the one that never does this.
    await ensureEventsPartitions(pool);

    const stats = await runRetention(pool, {
      eventsRetentionDays: config.EVENTS_RETENTION_DAYS,
      dlqRetentionDays: config.DLQ_RETENTION_DAYS,
      execute,
    });

    console.log(
      `[retain] done mode=${execute ? "execute" : "dry-run"} ` +
        `events_candidates=${stats.eventsCandidates} events_deleted=${stats.eventsDeleted} ` +
        `events_partitions_dropped=${stats.eventsPartitionsDropped.join(",") || "none"} ` +
        `dlq_candidates=${stats.dlqCandidates} dlq_deleted=${stats.dlqDeleted} ` +
        `(events_ttl_days=${config.EVENTS_RETENTION_DAYS} dlq_ttl_days=${config.DLQ_RETENTION_DAYS})`,
    );
    return 0;
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("[retain] error:", err);
  process.exit(1);
});
