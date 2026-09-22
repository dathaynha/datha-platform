import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import sensible from "@fastify/sensible";
import { buildLoggerOptions } from "./lib/logger";
import dbPlugin from "./plugins/db";
import metricsPlugin from "./plugins/metrics";
import authPlugin from "./plugins/auth";
import workspacePlugin from "./plugins/workspace";
import healthRoutes from "./routes/health";
import usersRoutes from "./routes/users";

export async function buildApp() {
  const fastify = Fastify({
    logger: buildLoggerOptions("accounts-service"),
    // Adopt the gateway's correlation id so one id spans gateway + service logs.
    genReqId: (req) =>
      (req.headers["x-correlation-id"] as string) ?? randomUUID(),
    requestIdLogLabel: "correlation_id",
  });

  await fastify.register(sensible);
  await fastify.register(dbPlugin);
  await fastify.register(metricsPlugin);
  await fastify.register(authPlugin);
  await fastify.register(workspacePlugin);

  await fastify.register(healthRoutes);
  await fastify.register(usersRoutes);

  return fastify;
}
