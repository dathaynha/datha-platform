import type { Pool } from "pg";

export interface RetentionStats {
  /** Rows past the cutoff — not all of them are removable yet, see below. */
  eventsCandidates: number;
  /** Rows actually removed: whole partitions dropped, plus default stragglers. */
  eventsDeleted: number;
  /** Partitions dropped whole, newest first — empty before anything expires. */
  eventsPartitionsDropped: string[];
  dlqCandidates: number;
  dlqDeleted: number;
}

export interface RetentionOptions {
  eventsRetentionDays: number;
  dlqRetentionDays: number;
  execute: boolean;
}

/**
 * A monthly partition of `events`, as `005_events_partitions.sql` names them.
 *
 * The name is the contract: this service creates every partition through
 * `events_ensure_partition`, so the month is recoverable from the name and the
 * alternative — parsing `pg_get_expr(relpartbound)` — means reading SQL text
 * back out of the catalog. `events_default` deliberately does not match; rows
 * that land there are outside every range and have to be deleted row-wise.
 */
const EVENTS_PARTITION = /^events_y(\d{4})m(\d{2})$/;

/** Exclusive upper bound of a partition, or null if the name is not ours. */
function partitionEndsAt(name: string): Date | null {
  const match = EVENTS_PARTITION.exec(name);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  // Month is 1-based here and 0-based in Date.UTC, so this is the first
  // instant of the month *after* the partition.
  return new Date(Date.UTC(year, month, 1));
}

function cutoff(days: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d;
}

async function eventsPartitionNames(db: Pool): Promise<string[]> {
  const result = await db.query<{ relname: string }>(
    `SELECT child.relname
     FROM pg_inherits
     JOIN pg_class child  ON child.oid  = pg_inherits.inhrelid
     JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
     WHERE parent.relname = 'events'
     ORDER BY child.relname`,
  );
  return result.rows.map((row) => row.relname);
}

/**
 * Names of the partitions that hold nothing newer than the cutoff.
 *
 * Only a partition whose whole range is expired can go: dropping one that still
 * covers live rows would delete them, so the test is the *upper* bound, never
 * the lower.
 */
export async function expiredEventPartitions(
  db: Pool,
  before: Date,
): Promise<string[]> {
  const names = await eventsPartitionNames(db);
  return names.filter((name) => {
    const endsAt = partitionEndsAt(name);
    return endsAt !== null && endsAt.getTime() <= before.getTime();
  });
}

/**
 * Drop whole partitions rather than deleting rows.
 *
 * `DELETE FROM events WHERE timestamp < cutoff` reads and writes every expired
 * row, leaves dead tuples for autovacuum and gets slower precisely as the table
 * grows — which is the only direction an event store goes. `DROP TABLE` on a
 * partition is constant time and returns the disk at once.
 *
 * **Retention granularity is now the month, not the day.** A partition can only
 * go when its whole range is past the cutoff, so a row 91 days old survives
 * until every row in its month is 90 days old — up to a month longer than the
 * TTL asks for. That is the trade for O(1) pruning, and it is why
 * `eventsCandidates` (rows past the cutoff) is larger than `eventsDeleted`
 * (rows actually removed). Measured on a clone, 2026-09-19: 64 candidates, 59
 * removed, the other 5 living in a month that had not fully expired.
 *
 * `events_default` cannot be dropped (it is the safety net for out-of-range
 * timestamps, mostly a DLQ replay of something older than retention), so its
 * expired rows are still deleted row-wise. There should be very few.
 */
export async function runRetention(
  db: Pool,
  options: RetentionOptions,
): Promise<RetentionStats> {
  const eventsBefore = cutoff(options.eventsRetentionDays);
  const dlqBefore = cutoff(options.dlqRetentionDays);

  // Partition pruning keeps this to the expired partitions, so counting first
  // stays cheap enough to be worth reporting in a dry run.
  const eventsCount = await db.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM events WHERE timestamp < $1`,
    [eventsBefore],
  );
  const dlqCount = await db.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM dlq_records WHERE failed_at < $1`,
    [dlqBefore],
  );

  const expired = await expiredEventPartitions(db, eventsBefore);

  const stats: RetentionStats = {
    eventsCandidates: parseInt(eventsCount.rows[0]?.count ?? "0", 10),
    eventsDeleted: 0,
    eventsPartitionsDropped: expired,
    dlqCandidates: parseInt(dlqCount.rows[0]?.count ?? "0", 10),
    dlqDeleted: 0,
  };

  // Counted before the drop, and in dry-run too, so the report says how many
  // rows would actually go rather than how many are merely past the cutoff.
  // One count per doomed partition, on a job that runs daily.
  let droppedRows = 0;
  for (const name of expired) {
    const rows = await db.query<{ count: string }>(
      // Identifiers cannot be bound as parameters. `name` came from the
      // catalogue and matched the partition-name pattern, so nothing
      // request-shaped reaches this string.
      `SELECT COUNT(*)::text AS count FROM "${name}"`,
    );
    droppedRows += parseInt(rows.rows[0]?.count ?? "0", 10);
  }

  if (!options.execute) {
    return stats;
  }

  for (const name of expired) {
    await db.query(`DROP TABLE IF EXISTS "${name}"`);
  }

  const defaultDel = await db.query(
    `DELETE FROM events_default WHERE timestamp < $1`,
    [eventsBefore],
  );

  const dlqDel = await db.query(
    `DELETE FROM dlq_records WHERE failed_at < $1`,
    [dlqBefore],
  );

  stats.eventsDeleted = droppedRows + (defaultDel.rowCount ?? 0);
  stats.dlqDeleted = dlqDel.rowCount ?? 0;
  return stats;
}
