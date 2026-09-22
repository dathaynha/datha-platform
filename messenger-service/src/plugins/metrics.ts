import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import client from "prom-client";

declare module "fastify" {
  interface FastifyInstance {
    metrics: {
      messagesSent: client.Counter<"kind">;
      conversationsCreated: client.Counter<"type">;
      readReceipts: client.Counter<string>;
      fanoutPublish: client.Counter<"outcome">;
      eventPublish: client.Counter<"outcome">;
      attachmentGrants: client.Counter<"outcome">;
      callsProjected: client.Counter<"outcome">;
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
      name: "messenger_service_http_requests_total",
      help: "Total HTTP requests handled.",
      labelNames: ["code", "method", "route"],
      registers: [registry],
    });

    const requestDuration = new client.Histogram({
      name: "messenger_service_http_request_duration_seconds",
      help: "HTTP request duration in seconds.",
      labelNames: ["code", "method", "route"],
      registers: [registry],
    });

    const messagesSent = new client.Counter({
      name: "messenger_service_messages_sent_total",
      help: "Messages accepted, by kind.",
      labelNames: ["kind"],
      registers: [registry],
    });

    const conversationsCreated = new client.Counter({
      name: "messenger_service_conversations_created_total",
      help: "Conversations created, by type. Idempotent hits are not counted.",
      labelNames: ["type"],
      registers: [registry],
    });

    const readReceipts = new client.Counter({
      name: "messenger_service_read_receipts_total",
      help: "Read watermark advances.",
      registers: [registry],
    });

    const fanoutPublish = new client.Counter({
      name: "messenger_service_fanout_publish_total",
      help: "Core NATS live-frame publishes, by outcome.",
      labelNames: ["outcome"],
      registers: [registry],
    });

    const eventPublish = new client.Counter({
      name: "messenger_service_event_publish_total",
      help: "JetStream envelope publishes after commit, by outcome.",
      labelNames: ["outcome"],
      registers: [registry],
    });

    const attachmentGrants = new client.Counter({
      name: "messenger_service_attachment_grants_total",
      help: "Attachment download URLs handed out, by outcome.",
      labelNames: ["outcome"],
      registers: [registry],
    });

    const callsProjected = new client.Counter({
      name: "messenger_service_calls_projected_total",
      help: "Call events consumed from JetStream, by outcome.",
      labelNames: ["outcome"],
      registers: [registry],
    });

    fastify.decorate("metrics", {
      messagesSent,
      conversationsCreated,
      readReceipts,
      fanoutPublish,
      eventPublish,
      attachmentGrants,
      callsProjected,
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
