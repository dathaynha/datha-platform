import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import sensible from "@fastify/sensible";
import { buildLoggerOptions } from "./lib/logger";
import dbPlugin from "./plugins/db";
import { ensureEventsPartitions } from "./services/partitions";
import natsPlugin from "./plugins/nats";
import metricsPlugin from "./plugins/metrics";
import healthRoutes from "./routes/health";
import eventsRoutes from "./routes/events";
import dlqRoutes from "./routes/dlq";

export async function buildApp() {
  const fastify = Fastify({
    logger: buildLoggerOptions("event-store"),
    // Adopt the gateway's correlation id so one id spans gateway + service logs.
    genReqId: (req) =>
      (req.headers["x-correlation-id"] as string) ?? randomUUID(),
    requestIdLogLabel: "correlation_id",
  });

  await fastify.register(sensible);
  await fastify.register(dbPlugin);
  // Before anything can ingest: a month with no partition is a failed insert,
  // not a slow query. Idempotent, and the retention job does it again daily so
  // this is not the only thing standing between the store and a missing month.
  await ensureEventsPartitions(fastify.db);
  await fastify.register(natsPlugin);
  await fastify.register(metricsPlugin);

  await fastify.register(healthRoutes);
  await fastify.register(eventsRoutes);
  await fastify.register(dlqRoutes);

  return fastify;
}
