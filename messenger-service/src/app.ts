import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import sensible from "@fastify/sensible";
import { buildLoggerOptions } from "./lib/logger";
import dbPlugin from "./plugins/db";
import metricsPlugin from "./plugins/metrics";
import natsPlugin from "./plugins/nats";
import callSweepPlugin from "./plugins/call-sweep";
import authPlugin from "./plugins/auth";
import healthRoutes from "./routes/health";
import conversationRoutes from "./routes/conversations";
import messageRoutes from "./routes/messages";
import callRoutes from "./routes/calls";

export async function buildApp() {
  const fastify = Fastify({
    logger: buildLoggerOptions("messenger-service"),
    // Adopt the gateway's correlation id so one id spans gateway + service logs
    // and every event envelope this service publishes.
    genReqId: (req) =>
      (req.headers["x-correlation-id"] as string) ?? randomUUID(),
    requestIdLogLabel: "correlation_id",
  });

  await fastify.register(sensible);
  await fastify.register(dbPlugin);
  await fastify.register(metricsPlugin);
  await fastify.register(natsPlugin);
  await fastify.register(callSweepPlugin);
  await fastify.register(authPlugin);

  await fastify.register(healthRoutes);
  await fastify.register(conversationRoutes);
  await fastify.register(messageRoutes);
  await fastify.register(callRoutes);

  return fastify;
}
