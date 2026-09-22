import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import sensible from "@fastify/sensible";
import { buildLoggerOptions } from "./lib/logger";
import dbPlugin from "./plugins/db";
import blobPlugin from "./plugins/blob";
import authPlugin from "./plugins/auth";
import natsPlugin from "./plugins/nats";
import metricsPlugin from "./plugins/metrics";
import healthRoutes from "./routes/health";
import fileRoutes from "./routes/files";

export async function buildApp() {
  const fastify = Fastify({
    logger: buildLoggerOptions("file-service"),
    // Adopt the gateway's correlation id so one id spans gateway + service logs.
    genReqId: (req) =>
      (req.headers["x-correlation-id"] as string) ?? randomUUID(),
    requestIdLogLabel: "correlation_id",
  });

  await fastify.register(sensible);
  await fastify.register(dbPlugin);
  await fastify.register(blobPlugin);
  await fastify.register(authPlugin);
  await fastify.register(natsPlugin);
  await fastify.register(metricsPlugin);

  await fastify.register(healthRoutes);
  await fastify.register(fileRoutes);

  return fastify;
}
