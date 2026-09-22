import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { config } from "../config";
import { parseQueryStringArray } from "../lib/query-array";
import { DlqReplayError, replayDlqRecord } from "../services/dlq-replay";
import {
  getDlqRecordById,
  listDlqSinks,
  queryDlqRecords,
} from "../services/dlq-query";

const stringArrayQuery = z.preprocess(
  (value) => parseQueryStringArray(value as string | string[] | undefined),
  z.array(z.string().min(1)).optional(),
);

const listQuerySchema = z.object({
  owner_id: z.string().optional(),
  sink: stringArrayQuery,
  correlation_id: z.string().optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
  order: z.enum(["asc", "desc"]).optional(),
});

const idParamsSchema = z.object({
  id: z.string().uuid(),
});

/** Ops DLQ API — no owner scope; call via api-gateway (JWT). Admin role later. */
export default async function dlqRoutes(fastify: FastifyInstance) {
  fastify.get("/dlq", async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid query params",
        details: parsed.error.flatten(),
      });
    }

    const q = parsed.data;
    try {
      const result = await queryDlqRecords(fastify.db, {
        ownerId: q.owner_id,
        sinks: q.sink,
        correlationId: q.correlation_id,
        from: q.from ? new Date(q.from) : undefined,
        to: q.to ? new Date(q.to) : undefined,
        limit: q.limit,
        offset: q.offset,
        order: q.order,
        countCap: config.LIST_COUNT_CAP,
      });
      return reply.send(result);
    } catch (err) {
      request.log.error({ err }, "GET /dlq failed");
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  /* Distinct sinks, for the ops filter. Static segment, matched ahead of
     `/dlq/:id`, which only accepts a UUID. */
  fastify.get(
    "/dlq/sinks",
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const sinks = await listDlqSinks(fastify.db);
        return reply.send({ data: sinks });
      } catch (err) {
        request.log.error({ err }, "GET /dlq/sinks failed");
        return reply.status(500).send({ error: "Internal server error" });
      }
    },
  );

  fastify.get<{ Params: { id: string } }>(
    "/dlq/:id",
    async (request, reply) => {
      const params = idParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({
          error: "Invalid path params",
          details: params.error.flatten(),
        });
      }

      try {
        const record = await getDlqRecordById(fastify.db, params.data.id);
        if (!record) {
          return reply.status(404).send({ error: "DLQ record not found" });
        }
        return reply.send(record);
      } catch (err) {
        request.log.error({ err }, "GET /dlq/:id failed");
        return reply.status(500).send({ error: "Internal server error" });
      }
    },
  );

  fastify.post<{ Params: { id: string } }>(
    "/dlq/:id/replay",
    async (request, reply) => {
      const params = idParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({
          error: "Invalid path params",
          details: params.error.flatten(),
        });
      }

      try {
        const result = await replayDlqRecord(
          fastify.db,
          fastify.js,
          params.data.id,
        );
        return reply.status(202).send(result);
      } catch (err) {
        if (err instanceof DlqReplayError) {
          return reply.status(err.statusCode).send({ error: err.message });
        }
        request.log.error({ err }, "POST /dlq/:id/replay failed");
        return reply.status(500).send({ error: "Internal server error" });
      }
    },
  );
}
