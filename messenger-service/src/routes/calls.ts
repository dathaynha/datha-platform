import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { config } from "../config";
import { authorizeConversation } from "../services/authz";
import { listConversationCalls, listOwnerCalls } from "../services/calls";

const idParamsSchema = z.object({ id: z.string().uuid() });

const limitQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/**
 * Call history — a read model over the `calls` table, which the JetStream
 * projection fills from realtime-service's events. Nothing here writes: a call
 * only exists because it happened on the socket.
 */
export default async function callRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  // Declared before /calls/:something would be, and kept separate from the
  // conversation-scoped list below, because the two authorize differently.
  fastify.get(
    "/calls",
    { preHandler: fastify.authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = limitQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.status(400).send({ error: "invalid limit" });
      }
      try {
        const calls = await listOwnerCalls(
          fastify.db,
          request.ownerId,
          query.data.limit ?? config.CALLS_PAGE_SIZE,
        );
        return reply.send({ data: calls });
      } catch (err) {
        request.log.error({ err }, "GET /calls failed");
        return reply.status(500).send({ error: "Internal server error" });
      }
    },
  );

  fastify.get(
    "/conversations/:id/calls",
    { preHandler: fastify.authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = idParamsSchema.safeParse(request.params);
      const query = limitQuerySchema.safeParse(request.query);
      if (!params.success || !query.success) {
        return reply.status(400).send({ error: "invalid request" });
      }
      try {
        const auth = await authorizeConversation(fastify.db, {
          conversationId: params.data.id,
          ownerId: request.ownerId,
          tenantId: config.DEFAULT_TENANT_ID,
          action: "conversation.read",
        });
        // Denied and missing both answer 404, as everywhere else here: a 403
        // would confirm the id exists.
        if (!auth.allowed) {
          return reply.status(404).send({ error: "Conversation not found" });
        }
        const calls = await listConversationCalls(
          fastify.db,
          params.data.id,
          query.data.limit ?? config.CALLS_PAGE_SIZE,
        );
        return reply.send({ data: calls });
      } catch (err) {
        request.log.error({ err }, "GET /conversations/:id/calls failed");
        return reply.status(500).send({ error: "Internal server error" });
      }
    },
  );
}
