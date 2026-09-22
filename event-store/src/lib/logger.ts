import type { FastifyServerOptions } from "fastify";

/**
 * Pino logger options: JSON to stdout always; when OTEL_EXPORTER_OTLP_ENDPOINT
 * is set, logs are also pushed via OTLP to the observability stack
 * (platform-observability repo). The transport reads the endpoint env itself.
 */
export function buildLoggerOptions(
  serviceName: string,
): FastifyServerOptions["logger"] {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    return true;
  }

  return {
    level: "info",
    transport: {
      targets: [
        // stdout stays untouched (destination 1 = fd 1)
        { target: "pino/file", options: { destination: 1 } },
        {
          target: "pino-opentelemetry-transport",
          options: {
            loggerName: serviceName,
            resourceAttributes: { "service.name": serviceName },
          },
        },
      ],
    },
  };
}
