import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import client from "prom-client";

/**
 * RED metrics + /metrics exposition for Prometheus (platform-observability).
 * Route label uses the matched route pattern, never the raw URL, to keep
 * label cardinality bounded. /metrics and /health are excluded from stats.
 */
export default fp(
  async (fastify: FastifyInstance) => {
    const registry = new client.Registry();
    client.collectDefaultMetrics({ register: registry });

    const requestsTotal = new client.Counter({
      name: "file_service_http_requests_total",
      help: "Total HTTP requests handled.",
      labelNames: ["code", "method", "route"],
      registers: [registry],
    });

    const requestDuration = new client.Histogram({
      name: "file_service_http_request_duration_seconds",
      help: "HTTP request duration in seconds.",
      labelNames: ["code", "method", "route"],
      registers: [registry],
    });

    fastify.addHook("onResponse", async (request, reply) => {
      const route = request.routeOptions.url ?? "unmatched";
      if (route === "/metrics" || route === "/health") return;

      const labels = {
        code: String(reply.statusCode),
        method: request.method,
        route,
      };
      requestsTotal.inc(labels);
      requestDuration.observe(labels, reply.elapsedTime / 1000);
    });

    fastify.get("/metrics", async (_request, reply) => {
      reply.type(registry.contentType);
      return registry.metrics();
    });
  },
  { name: "metrics" },
);
