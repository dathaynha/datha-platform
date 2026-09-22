import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import sensible from "@fastify/sensible";
import { buildLoggerOptions } from "./lib/logger";
import dbPlugin from "./plugins/db";
import natsPlugin from "./plugins/nats";
import metricsPlugin from "./plugins/metrics";
import authPlugin from "./plugins/auth";
import streamPlugin from "./plugins/stream";
import pushPlugin from "./plugins/push";
import retentionPlugin from "./plugins/retention";
import emailDigestPlugin from "./plugins/email-digest";
import healthRoutes from "./routes/health";
import notificationsRoutes from "./routes/notifications";

export async function buildApp() {
  const fastify = Fastify({
    logger: buildLoggerOptions("notification-service"),
    // Adopt the gateway's correlation id so one id spans gateway + service logs.
    genReqId: (req) =>
      (req.headers["x-correlation-id"] as string) ?? randomUUID(),
    requestIdLogLabel: "correlation_id",
  });

  await fastify.register(sensible);
  await fastify.register(dbPlugin);
  await fastify.register(metricsPlugin);
  await fastify.register(natsPlugin);
  await fastify.register(authPlugin);
  await fastify.register(streamPlugin);
  await fastify.register(pushPlugin);
  await fastify.register(retentionPlugin);
  await fastify.register(emailDigestPlugin);

  await fastify.register(healthRoutes);
  await fastify.register(notificationsRoutes);

  return fastify;
}
