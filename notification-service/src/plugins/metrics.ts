import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import client from "prom-client";

declare module "fastify" {
  interface FastifyInstance {
    metrics: {
      eventsConsumed: client.Counter<"stream" | "outcome">;
      sseConnections: client.Gauge;
      pushSent: client.Counter<"outcome">;
      emailsSent: client.Counter<"outcome">;
    };
  }
}

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
      name: "notification_service_http_requests_total",
      help: "Total HTTP requests handled.",
      labelNames: ["code", "method", "route"],
      registers: [registry],
    });

    const requestDuration = new client.Histogram({
      name: "notification_service_http_request_duration_seconds",
      help: "HTTP request duration in seconds.",
      labelNames: ["code", "method", "route"],
      registers: [registry],
    });

    const eventsConsumed = new client.Counter({
      name: "notification_service_events_consumed_total",
      help: "JetStream messages consumed, by stream and projection outcome.",
      labelNames: ["stream", "outcome"],
      registers: [registry],
    });

    const sseConnections = new client.Gauge({
      name: "notification_service_sse_connections",
      help: "Currently open notification SSE connections.",
      registers: [registry],
    });

    const pushSent = new client.Counter({
      name: "notification_service_push_sent_total",
      help: "Web Push sends, by outcome.",
      labelNames: ["outcome"],
      registers: [registry],
    });

    const emailsSent = new client.Counter({
      name: "notification_service_emails_sent_total",
      help: "Digest emails, by outcome.",
      labelNames: ["outcome"],
      registers: [registry],
    });

    fastify.decorate("metrics", {
      eventsConsumed,
      sseConnections,
      pushSent,
      emailsSent,
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
