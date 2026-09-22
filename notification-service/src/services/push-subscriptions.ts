import type { Pool } from "pg";

export interface PushSubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string;
}

export interface PushSubscriptionRow {
  id: string;
  owner_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** Upsert by endpoint — re-subscribing from the same browser refreshes keys + ownership. */
export async function upsertSubscription(
  db: Pool,
  ownerId: string,
  sub: PushSubscriptionInput,
): Promise<void> {
  await db.query(
    `INSERT INTO push_subscriptions (owner_id, endpoint, p256dh, auth, user_agent)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (endpoint) DO UPDATE SET
       owner_id = EXCLUDED.owner_id,
       p256dh = EXCLUDED.p256dh,
       auth = EXCLUDED.auth,
       user_agent = EXCLUDED.user_agent,
       last_seen_at = now()`,
    [ownerId, sub.endpoint, sub.p256dh, sub.auth, sub.userAgent ?? ""],
  );
}

/** Owner-scoped — a user can only remove their own subscription. */
export async function deleteSubscription(
  db: Pool,
  ownerId: string,
  endpoint: string,
): Promise<void> {
  await db.query(
    `DELETE FROM push_subscriptions WHERE owner_id = $1 AND endpoint = $2`,
    [ownerId, endpoint],
  );
}

/** Unscoped delete — used when a push service reports the endpoint gone (404/410). */
export async function pruneSubscription(
  db: Pool,
  endpoint: string,
): Promise<void> {
  await db.query(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [
    endpoint,
  ]);
}

export async function listSubscriptions(
  db: Pool,
  ownerId: string,
): Promise<PushSubscriptionRow[]> {
  const result = await db.query<PushSubscriptionRow>(
    `SELECT id, owner_id, endpoint, p256dh, auth FROM push_subscriptions WHERE owner_id = $1`,
    [ownerId],
  );
  return result.rows;
}
