/** Env key for a durable-specific max_deliver override (dashes → underscores, uppercased). */
export function maxDeliverEnvKey(durableName: string): string {
  return `NATS_CONSUMER_MAX_DELIVER_${durableName.replace(/-/g, "_").toUpperCase()}`;
}

function parsePositiveInt(raw: string, label: string): number {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return n;
}

/** Platform default — applies to every pull durable unless overridden. */
export function platformMaxDeliver(): number {
  return parsePositiveInt(
    process.env.NATS_CONSUMER_MAX_DELIVER ?? "3",
    "NATS_CONSUMER_MAX_DELIVER",
  );
}

/**
 * max_deliver for a durable: `NATS_CONSUMER_MAX_DELIVER_<DURABLE>` if set, else platform default.
 * Example override: NATS_CONSUMER_MAX_DELIVER_FILE_SERVICE_CONVERSATION_CLEANUP=5
 */
export function maxDeliverForDurable(durableName: string): number {
  const key = maxDeliverEnvKey(durableName);
  const override = process.env[key];
  if (override !== undefined && override.trim() !== "") {
    return parsePositiveInt(override, key);
  }
  return platformMaxDeliver();
}
