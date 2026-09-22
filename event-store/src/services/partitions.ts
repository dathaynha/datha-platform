import type { Pool } from "pg";

/** Months of empty partitions kept ahead of now. */
export const PARTITION_MONTHS_AHEAD = 3;

/**
 * Make sure `events` has a partition for this month and the next few.
 *
 * A missing partition is not a slow query, it is a failed insert — the row goes
 * to the default partition at best and errors at worst — so this runs from two
 * places that do not depend on each other: the service on boot, and the
 * retention job daily. The same lesson as the call reaper: whatever closes a
 * gap must be reachable by more than the one process you expect to be alive.
 *
 * Idempotent and cheap (a catalog lookup per month), so calling it twice costs
 * nothing.
 */
export async function ensureEventsPartitions(
  db: Pool,
  monthsAhead: number = PARTITION_MONTHS_AHEAD,
): Promise<void> {
  try {
    // The cast is not optional: a bound parameter arrives as `unknown`, and
    // Postgres will not resolve an overload from it.
    await db.query("SELECT events_ensure_partitions($1::int)", [monthsAhead]);
  } catch (err) {
    // This now runs before the service will accept traffic, so an unmigrated
    // database stops being "queries fail later" and becomes "will not boot".
    // Say which command fixes it, rather than leaving a bare
    // `function events_ensure_partitions(integer) does not exist`.
    throw new Error(
      "Could not ensure the events partitions. If this database has not been " +
        "migrated yet, run `pnpm migrate` first (migration 005 creates the " +
        `function). Cause: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
