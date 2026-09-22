import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { config } from "../config";
import { authorizeConversation } from "../services/authz";
import {
  BadConversationInput,
  createConversation,
  getConversation,
  getUnreadConversationIds,
  leaveConversation,
  listConversations,
  updateConversationTitle,
  upsertParticipants,
} from "../services/conversations";
import { markRead } from "../services/read-state";
import { getMessage } from "../services/messages";
import { announce, recordEvent } from "../services/announce";
import { EVENT_CONVERSATION_CREATED } from "../nats/streams";
import { toParticipant } from "../types/messenger";

const createBodySchema = z.object({
  type: z.enum(["direct", "group"]),
  participant_owner_ids: z.array(z.string().min(1)).min(1).max(500),
  title: z.string().trim().max(200).optional(),
});

const listQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(config.CONVERSATIONS_PAGE_SIZE)
    .default(config.CONVERSATIONS_PAGE_SIZE),
  // `<ISO timestamp>|<uuid>` — the list's keyset cursor is a tuple, because a
  // timestamp alone cannot break a tie without dropping rows. Opaque to the
  // client; validated only for shape.
  cursor: z
    .string()
    .regex(
      /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\|[0-9a-fA-F-]{36}$/,
      "cursor must be '<iso timestamp>|<uuid>'",
    )
    .optional(),
});

const idParamsSchema = z.object({ id: z.string().uuid() });

const titleBodySchema = z.object({
  title: z.string().trim().max(200).nullable(),
});

const participantsBodySchema = z.object({
  owner_ids: z.array(z.string().min(1)).min(1),
});

const readBodySchema = z.object({ message_id: z.string().uuid() });

/** Owner-scoped via gateway-injected X-Owner-ID (auth plugin). */
export default async function conversationRoutes(fastify: FastifyInstance) {
  fastify.post(
    "/conversations",
    { preHandler: fastify.authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = createBodySchema.safeParse(request.body);
      if (!body.success) {
        return reply
          .status(400)
          .send({ error: body.error.flatten().fieldErrors });
      }
      if (
        body.data.type === "group" &&
        body.data.participant_owner_ids.length + 1 >
          config.MAX_GROUP_PARTICIPANTS
      ) {
        return reply.status(400).send({
          error: `a group may hold at most ${config.MAX_GROUP_PARTICIPANTS} participants`,
        });
      }

      try {
        const result = await createConversation(fastify.db, {
          ownerId: request.ownerId,
          tenantId: config.DEFAULT_TENANT_ID,
          type: body.data.type,
          participantOwnerIds: body.data.participant_owner_ids,
          title: body.data.title ?? null,
        });

        if (result.created) {
          fastify.metrics.conversationsCreated.inc({ type: body.data.type });
          const ownerIds = result.participants.map((p) => p.owner_id);
          await recordEvent(fastify, {
            type: EVENT_CONVERSATION_CREATED,
            entityId: result.conversation.id,
            ownerId: request.ownerId,
            correlationId: request.id,
            payload: {
              conversation_id: result.conversation.id,
              type: result.conversation.type,
              participant_owner_ids: ownerIds,
            },
          });
          announce(fastify, ownerIds, {
            t: "conversation.created",
            d: { conversation_id: result.conversation.id },
          });
        }

        const hydrated = await getConversation(
          fastify.db,
          result.conversation.id,
          request.ownerId,
        );
        return reply
          .status(result.created ? 201 : 200)
          .send({ data: hydrated });
      } catch (err) {
        if (err instanceof BadConversationInput) {
          return reply.status(400).send({ error: err.message });
        }
        request.log.error({ err }, "POST /conversations failed");
        return reply.status(500).send({ error: "Internal server error" });
      }
    },
  );

  fastify.get(
    "/conversations",
    { preHandler: fastify.authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = listQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply
          .status(400)
          .send({ error: query.error.flatten().fieldErrors });
      }
      try {
        const result = await listConversations(fastify.db, {
          ownerId: request.ownerId,
          limit: query.data.limit,
          cursor: query.data.cursor ?? null,
        });
        return reply.send({
          data: result.conversations,
          meta: { next_cursor: result.nextCursor },
        });
      } catch (err) {
        request.log.error({ err }, "GET /conversations failed");
        return reply.status(500).send({ error: "Internal server error" });
      }
    },
  );

  // Declared before /conversations/:id so "unread" is never parsed as an id.
  fastify.get(
    "/conversations/unread",
    { preHandler: fastify.authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const ids = await getUnreadConversationIds(fastify.db, request.ownerId);
        return reply.send({ data: { conversation_ids: ids } });
      } catch (err) {
        request.log.error({ err }, "GET /conversations/unread failed");
        return reply.status(500).send({ error: "Internal server error" });
      }
    },
  );

  fastify.get(
    "/conversations/:id",
    { preHandler: fastify.authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = idParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: "invalid conversation id" });
      }
      try {
        const auth = await authorizeConversation(fastify.db, {
          conversationId: params.data.id,
          ownerId: request.ownerId,
          tenantId: config.DEFAULT_TENANT_ID,
          action: "conversation.read",
        });
        // Denied and missing both answer 404: a 403 would confirm the id exists.
        if (!auth.allowed) {
          return reply.status(404).send({ error: "Conversation not found" });
        }
        const conversation = await getConversation(
          fastify.db,
          params.data.id,
          request.ownerId,
        );
        return reply.send({ data: conversation });
      } catch (err) {
        request.log.error({ err }, "GET /conversations/:id failed");
        return reply.status(500).send({ error: "Internal server error" });
      }
    },
  );

  fastify.patch(
    "/conversations/:id",
    { preHandler: fastify.authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = idParamsSchema.safeParse(request.params);
      const body = titleBodySchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.status(400).send({ error: "invalid request" });
      }
      try {
        const auth = await authorizeConversation(fastify.db, {
          conversationId: params.data.id,
          ownerId: request.ownerId,
          tenantId: config.DEFAULT_TENANT_ID,
          action: "conversation.write",
        });
        if (!auth.facts) {
          return reply.status(404).send({ error: "Conversation not found" });
        }
        // A participant who is not an admin exists as far as this caller knows,
        // so this one is a real 403 rather than a hidden 404.
        if (!auth.allowed) {
          return reply.status(403).send({ error: "Admin role required" });
        }
        const updated = await updateConversationTitle(fastify.db, {
          conversationId: params.data.id,
          title: body.data.title,
        });
        if (!updated) {
          return reply
            .status(400)
            .send({ error: "only group conversations have a title" });
        }
        const conversation = await getConversation(
          fastify.db,
          params.data.id,
          request.ownerId,
        );
        return reply.send({ data: conversation });
      } catch (err) {
        request.log.error({ err }, "PATCH /conversations/:id failed");
        return reply.status(500).send({ error: "Internal server error" });
      }
    },
  );

  fastify.post(
    "/conversations/:id/participants",
    { preHandler: fastify.authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = idParamsSchema.safeParse(request.params);
      const body = participantsBodySchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.status(400).send({ error: "invalid request" });
      }
      try {
        const auth = await authorizeConversation(fastify.db, {
          conversationId: params.data.id,
          ownerId: request.ownerId,
          tenantId: config.DEFAULT_TENANT_ID,
          action: "conversation.write",
        });
        if (!auth.facts) {
          return reply.status(404).send({ error: "Conversation not found" });
        }
        if (!auth.allowed) {
          return reply.status(403).send({ error: "Admin role required" });
        }
        if (auth.facts.type === "direct") {
          return reply
            .status(400)
            .send({ error: "a direct conversation has fixed participants" });
        }
        const total = new Set([
          ...auth.facts.participants,
          ...body.data.owner_ids,
        ]).size;
        if (total > config.MAX_GROUP_PARTICIPANTS) {
          return reply.status(400).send({
            error: `a group may hold at most ${config.MAX_GROUP_PARTICIPANTS} participants`,
          });
        }
        const participants = await upsertParticipants(fastify.db, {
          conversationId: params.data.id,
          ownerIds: body.data.owner_ids,
          adminOwnerId: null,
        });
        return reply.send({ data: participants.map(toParticipant) });
      } catch (err) {
        request.log.error(
          { err },
          "POST /conversations/:id/participants failed",
        );
        return reply.status(500).send({ error: "Internal server error" });
      }
    },
  );

  fastify.delete(
    "/conversations/:id/participants/me",
    { preHandler: fastify.authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = idParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: "invalid conversation id" });
      }
      try {
        const left = await leaveConversation(fastify.db, {
          conversationId: params.data.id,
          ownerId: request.ownerId,
        });
        if (!left) {
          return reply.status(404).send({ error: "Conversation not found" });
        }
        return reply.status(204).send();
      } catch (err) {
        request.log.error({ err }, "DELETE participants/me failed");
        return reply.status(500).send({ error: "Internal server error" });
      }
    },
  );

  fastify.post(
    "/conversations/:id/read",
    { preHandler: fastify.authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = idParamsSchema.safeParse(request.params);
      const body = readBodySchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.status(400).send({ error: "invalid request" });
      }
      try {
        const auth = await authorizeConversation(fastify.db, {
          conversationId: params.data.id,
          ownerId: request.ownerId,
          tenantId: config.DEFAULT_TENANT_ID,
          action: "message.read",
        });
        if (!auth.allowed) {
          return reply.status(404).send({ error: "Conversation not found" });
        }
        // The watermark is the stored message timestamp, not a client clock: a
        // skewed browser must not be able to mark future messages read. The
        // message is resolved first so a bad id is a 404 rather than a silent
        // no-op from the update.
        const message = await getMessage(fastify.db, {
          conversationId: params.data.id,
          messageId: body.data.message_id,
        });
        if (!message) {
          return reply.status(404).send({ error: "Message not found" });
        }
        const result = await markRead(fastify.db, {
          conversationId: params.data.id,
          ownerId: request.ownerId,
          messageId: body.data.message_id,
        });
        if (!result) {
          return reply.status(404).send({ error: "Conversation not found" });
        }
        if (result.advanced) {
          fastify.metrics.readReceipts.inc();
          announce(fastify, [request.ownerId], {
            t: "unread.cleared",
            d: { conversation_id: params.data.id },
          });
          // Everyone else in the thread renders the read tick.
          const others = auth.facts?.participants.filter(
            (id) => id !== request.ownerId,
          );
          announce(fastify, others ?? [], {
            t: "receipt.read",
            d: {
              conversation_id: params.data.id,
              owner_id: request.ownerId,
              last_read_at: result.lastReadAt.toISOString(),
            },
          });
        }
        return reply.send({
          data: { last_read_at: result.lastReadAt.toISOString() },
        });
      } catch (err) {
        request.log.error({ err }, "POST /conversations/:id/read failed");
        return reply.status(500).send({ error: "Internal server error" });
      }
    },
  );
}
