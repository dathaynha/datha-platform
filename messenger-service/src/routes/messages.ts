import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { config } from "../config";
import { authorizeConversation } from "../services/authz";
import {
  AttachmentNotFound,
  createFileServiceClient,
  resolveAttachment,
} from "../services/attachments";
import { listMessages, sendMessage } from "../services/messages";
import { announce, recordEvent } from "../services/announce";
import { EVENT_MESSAGE_SENT } from "../nats/streams";
import { toMessage } from "../types/messenger";

const idParamsSchema = z.object({ id: z.string().uuid() });

const attachmentParamsSchema = z.object({
  id: z.string().uuid(),
  messageId: z.string().uuid(),
});

const sendBodySchema = z
  .object({
    client_message_id: z.string().min(1).max(200),
    body: z.string().max(8000).default(""),
    attachment_file_id: z.string().min(1).max(200).optional(),
    // An image attachment's downscaled copy and the original's pixel size,
    // both produced by the uploading client — nobody else ever holds the
    // bytes. Optional in every direction: an older client sends none and its
    // messages render from the original exactly as before.
    thumbnail_file_id: z.string().min(1).max(200).optional(),
    media_width: z.coerce.number().int().positive().max(100_000).optional(),
    media_height: z.coerce.number().int().positive().max(100_000).optional(),
  })
  .refine((v) => v.body.trim().length > 0 || v.attachment_file_id, {
    message: "a message needs a body or an attachment",
  })
  .refine((v) => !v.thumbnail_file_id || Boolean(v.attachment_file_id), {
    message: "a thumbnail needs the attachment it was derived from",
  });

const listQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(config.MESSAGES_PAGE_SIZE)
    .default(config.MESSAGES_PAGE_SIZE),
  before: z.string().datetime().optional(),
});

export default async function messageRoutes(fastify: FastifyInstance) {
  const files = createFileServiceClient(config.FILE_SERVICE_URL);

  fastify.post(
    "/conversations/:id/messages",
    { preHandler: fastify.authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = idParamsSchema.safeParse(request.params);
      const body = sendBodySchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.status(400).send({
          error: body.success ? "invalid conversation id" : body.error.issues,
        });
      }
      try {
        const auth = await authorizeConversation(fastify.db, {
          conversationId: params.data.id,
          ownerId: request.ownerId,
          tenantId: config.DEFAULT_TENANT_ID,
          action: "message.send",
        });
        if (!auth.allowed) {
          return reply.status(404).send({ error: "Conversation not found" });
        }

        const result = await sendMessage(fastify.db, {
          conversationId: params.data.id,
          senderOwnerId: request.ownerId,
          clientMessageId: body.data.client_message_id,
          kind: body.data.attachment_file_id ? "attachment" : "text",
          body: body.data.body,
          attachmentFileId: body.data.attachment_file_id ?? null,
          thumbnailFileId: body.data.thumbnail_file_id ?? null,
          mediaWidth: body.data.media_width ?? null,
          mediaHeight: body.data.media_height ?? null,
        });
        const message = toMessage(result.message);

        // A replayed client_message_id is the same message, so it is announced
        // once only — the first call already told everyone.
        if (result.created) {
          fastify.metrics.messagesSent.inc({ kind: result.message.kind });
          await recordEvent(fastify, {
            type: EVENT_MESSAGE_SENT,
            entityId: result.message.id,
            ownerId: request.ownerId,
            correlationId: request.id,
            payload: {
              conversation_id: params.data.id,
              message_id: result.message.id,
              kind: result.message.kind,
              attachment_file_id: result.message.attachment_file_id,
              participant_owner_ids: auth.facts?.participants ?? [],
            },
          });

          const recipients = (auth.facts?.participants ?? []).filter(
            (id) => id !== request.ownerId,
          );
          // Senders get the message frame (other tabs), recipients also get the
          // unread delta. Unread is a set of ids on the client, never a counter.
          announce(fastify, auth.facts?.participants ?? [], {
            t: "message.new",
            d: { conversation_id: params.data.id, message },
          });
          announce(fastify, recipients, {
            t: "unread.added",
            d: { conversation_id: params.data.id },
          });
        }

        return reply.status(result.created ? 201 : 200).send({ data: message });
      } catch (err) {
        request.log.error({ err }, "POST /conversations/:id/messages failed");
        return reply.status(500).send({ error: "Internal server error" });
      }
    },
  );

  fastify.get(
    "/conversations/:id/messages",
    { preHandler: fastify.authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = idParamsSchema.safeParse(request.params);
      const query = listQuerySchema.safeParse(request.query);
      if (!params.success || !query.success) {
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
        const result = await listMessages(fastify.db, {
          conversationId: params.data.id,
          limit: query.data.limit,
          before: query.data.before ?? null,
        });
        return reply.send({
          data: result.messages.map(toMessage),
          meta: { next_cursor: result.nextCursor },
        });
      } catch (err) {
        request.log.error({ err }, "GET /conversations/:id/messages failed");
        return reply.status(500).send({ error: "Internal server error" });
      }
    },
  );

  /**
   * Hands the reader a short-lived download URL for a message's attachment.
   *
   * The authorization that matters is conversation membership, which only this
   * service knows — file-service is owner-scoped, so the recipient of a file
   * could never fetch it there. Non-participants get 404, like everywhere else.
   */
  fastify.get(
    "/conversations/:id/messages/:messageId/attachment",
    { preHandler: fastify.authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = attachmentParamsSchema.safeParse(request.params);
      if (!params.success) {
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

        const attachment = await resolveAttachment(fastify.db, {
          conversationId: params.data.id,
          messageId: params.data.messageId,
        });
        const grant = await files.downloadUrl(
          attachment.fileId,
          attachment.ownerId,
        );

        // The thumbnail is what a thread paints; the original is only fetched
        // when someone opens it. Minted in parallel because they are two
        // independent blobs, and a failure to mint the small one must not cost
        // the reader the picture — it falls back to the original.
        const thumbnail = attachment.thumbnailFileId
          ? await files
              .downloadUrl(attachment.thumbnailFileId, attachment.ownerId)
              .catch((err: unknown) => {
                request.log.warn({ err }, "thumbnail grant failed");
                return null;
              })
          : null;

        fastify.metrics.attachmentGrants.inc({ outcome: "ok" });
        return reply.send({
          data: {
            name: attachment.name,
            download_url: grant.url,
            expires_at: grant.expiresAt,
            thumbnail_url: thumbnail?.url ?? null,
            width: attachment.width,
            height: attachment.height,
          },
        });
      } catch (err) {
        if (err instanceof AttachmentNotFound) {
          fastify.metrics.attachmentGrants.inc({ outcome: "not_found" });
          return reply.status(404).send({ error: "Attachment not found" });
        }
        fastify.metrics.attachmentGrants.inc({ outcome: "error" });
        request.log.error({ err }, "GET attachment failed");
        return reply.status(502).send({ error: "Attachment unavailable" });
      }
    },
  );
}
