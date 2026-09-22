import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { config } from "../config";
import { decodeCursor } from "../lib/cursor";
import { parseQueryStringArray } from "../lib/query-array";
import {
  getEventById,
  listEventServices,
  listEventTypes,
  listPayloadKeys,
  listPayloadValues,
  queryEvents,
} from "../services/query";

const idParamsSchema = z.object({
  id: z.string().uuid(),
});

const stringArrayQuery = z.preprocess(
  (value) => parseQueryStringArray(value as string | string[] | undefined),
  z.array(z.string().min(1)).optional(),
);

/** `?payload.origin=messenger` → `{ origin: "messenger" }`. */
const PAYLOAD_PREFIX = "payload.";
/** Payload keys are identifiers, so anything else is a malformed request. */
const PAYLOAD_KEY = /^[A-Za-z0-9_]{1,64}$/;

function parsePayloadFilters(
  query: unknown,
): { ok: true; value: Record<string, string> } | { ok: false; key: string } {
  const out: Record<string, string> = {};
  for (const [raw, value] of Object.entries(
    (query ?? {}) as Record<string, unknown>,
  )) {
    if (!raw.startsWith(PAYLOAD_PREFIX)) continue;
    const key = raw.slice(PAYLOAD_PREFIX.length);
    // Reject rather than ignore: a filter that is silently dropped returns
    // more rows than asked for, which reads as the filter not working.
    if (!PAYLOAD_KEY.test(key) || typeof value !== "string" || value === "") {
      return { ok: false, key: raw };
    }
    out[key] = value;
  }
  return { ok: true, value: out };
}

const payloadValuesSchema = z.object({
  key: z.string().regex(PAYLOAD_KEY),
});

const querySchema = z.object({
  type: stringArrayQuery,
  service: stringArrayQuery,
  entity_id: z.string().optional(),
  owner_id: z.string().optional(),
  correlation_id: z.string().optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
  order: z.enum(["asc", "desc"]).optional(),
  /** Opaque keyset cursor from a previous response's `nextCursor`. */
  after: z.string().min(1).optional(),
});

/** Ops/debug listing — no owner scope; gateway JWT required in prod. Optional ?owner_id= filter. */
export default async function eventsRoutes(fastify: FastifyInstance) {
  fastify.get(
    "/events",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = querySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "Invalid query params",
          details: parsed.error.flatten(),
        });
      }

      const q = parsed.data;

      // A malformed cursor is a 400, not a quiet reset to page one: a deep page
      // that silently restarts at the top reads as data loss.
      const after = q.after ? decodeCursor(q.after) : undefined;
      if (q.after && !after) {
        return reply.status(400).send({ error: "Invalid cursor" });
      }

      const payload = parsePayloadFilters(request.query);
      if (!payload.ok) {
        return reply
          .status(400)
          .send({ error: `Invalid payload filter: ${payload.key}` });
      }

      try {
        const result = await queryEvents(fastify.db, {
          ownerId: q.owner_id,
          types: q.type,
          services: q.service,
          entityId: q.entity_id,
          correlationId: q.correlation_id,
          from: q.from ? new Date(q.from) : undefined,
          to: q.to ? new Date(q.to) : undefined,
          limit: q.limit,
          offset: q.offset,
          order: q.order,
          countCap: config.LIST_COUNT_CAP,
          after: after ?? undefined,
          payload: Object.keys(payload.value).length
            ? payload.value
            : undefined,
        });
        return reply.send(result);
      } catch (err) {
        request.log.error({ err }, "GET /events failed");
        return reply.status(500).send({ error: "Internal server error" });
      }
    },
  );

  /* Distinct publishers, for the ops filter. A static segment, so it is matched
     ahead of `/events/:id` regardless of registration order — and that route
     only accepts a UUID anyway. */
  fastify.get(
    "/events/services",
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const services = await listEventServices(fastify.db);
        return reply.send({ data: services });
      } catch (err) {
        request.log.error({ err }, "GET /events/services failed");
        return reply.status(500).send({ error: "Internal server error" });
      }
    },
  );

  /* Distinct event types, for the same reason as `/events/services` — the
     filter was free text, so a typo read as "nothing of that kind happened". */
  fastify.get(
    "/events/types",
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const types = await listEventTypes(fastify.db);
        return reply.send({ data: types });
      } catch (err) {
        request.log.error({ err }, "GET /events/types failed");
        return reply.status(500).send({ error: "Internal server error" });
      }
    },
  );

  /* The payload filter's own options, so the field names and their values are
     picked from a menu rather than typed from memory. Static segments, matched
     ahead of `/events/:id`. */
  fastify.get(
    "/events/payload-keys",
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        return reply.send({ data: await listPayloadKeys(fastify.db) });
      } catch (err) {
        request.log.error({ err }, "GET /events/payload-keys failed");
        return reply.status(500).send({ error: "Internal server error" });
      }
    },
  );

  fastify.get(
    "/events/payload-values",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = payloadValuesSchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(400).send({ error: "Invalid payload key" });
      }
      try {
        return reply.send({
          data: await listPayloadValues(fastify.db, parsed.data.key),
        });
      } catch (err) {
        request.log.error({ err }, "GET /events/payload-values failed");
        return reply.status(500).send({ error: "Internal server error" });
      }
    },
  );

  fastify.get(
    "/events/:id",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = idParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({
          error: "Invalid id",
          details: params.error.flatten(),
        });
      }

      try {
        const event = await getEventById(fastify.db, params.data.id);
        if (!event) {
          return reply.status(404).send({ error: "Event not found" });
        }
        return reply.send(event);
      } catch (err) {
        request.log.error({ err }, "GET /events/:id failed");
        return reply.status(500).send({ error: "Internal server error" });
      }
    },
  );
}
