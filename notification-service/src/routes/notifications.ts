import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { getPreferences, upsertPreferences } from "../services/preferences";
import {
  deleteSubscription,
  upsertSubscription,
} from "../services/push-subscriptions";
import {
  listNotifications,
  markAllRead,
  setReadState,
  unreadCount,
} from "../services/query";

const listQuerySchema = z.object({
  unread: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  before: z.string().datetime({ offset: true }).optional(),
});

const idParamsSchema = z.object({
  id: z.string().uuid(),
});

/** SSE keepalive comments — proxies and browsers drop silent connections. */
const KEEPALIVE_INTERVAL_MS = 25_000;

const pushSubscriptionSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
  userAgent: z.string().max(500).optional(),
});

const pushUnsubscribeSchema = z.object({
  endpoint: z.string().url(),
});

const preferencesBodySchema = z.object({
  locale: z.string().min(2).max(10),
  pushEnabled: z.boolean(),
  pushMinSeverity: z.enum(["info", "warning", "critical"]),
  emailDigest: z.boolean(),
});

/** Owner-scoped via gateway-injected X-Owner-ID (auth plugin) — no cross-owner access. */
export default async function notificationsRoutes(fastify: FastifyInstance) {
  fastify.get(
    "/notifications",
    { preHandler: fastify.authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = listQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "Invalid query params",
          details: parsed.error.flatten(),
        });
      }

      const q = parsed.data;
      try {
        const data = await listNotifications(fastify.db, {
          ownerId: request.ownerId,
          unread: q.unread,
          limit: q.limit,
          before: q.before ? new Date(q.before) : undefined,
        });
        return reply.send({ data });
      } catch (err) {
        request.log.error({ err }, "GET /notifications failed");
        return reply.status(500).send({ error: "Internal server error" });
      }
    },
  );

  // SSE live push — one connection per browser tab, fanout via the stream plugin.
  // Auth: gateway verifies a stream_token and injects X-Owner-ID (EventSource
  // cannot send Authorization headers) — same preHandler as the REST routes.
  fastify.get(
    "/notifications/stream",
    { preHandler: fastify.authenticate },
    (request: FastifyRequest, reply: FastifyReply) => {
      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      // Guard: end() (shutdown) can race the keepalive timer / a broadcast —
      // writing after end throws ERR_STREAM_WRITE_AFTER_END and crashes the process.
      const write = (chunk: string) => {
        if (!reply.raw.writableEnded) reply.raw.write(chunk);
      };
      write("retry: 5000\n\n");

      const unsubscribe = fastify.notificationStream.subscribe(
        request.ownerId,
        {
          send: (data) => write(`event: notification\ndata: ${data}\n\n`),
          end: () => reply.raw.end(),
        },
      );
      const keepalive = setInterval(
        () => write(": keepalive\n\n"),
        KEEPALIVE_INTERVAL_MS,
      );

      request.raw.on("close", () => {
        clearInterval(keepalive);
        unsubscribe();
      });
    },
  );

  fastify.get(
    "/notifications/unread-count",
    { preHandler: fastify.authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const count = await unreadCount(fastify.db, request.ownerId);
        return reply.send({ count });
      } catch (err) {
        request.log.error({ err }, "GET /notifications/unread-count failed");
        return reply.status(500).send({ error: "Internal server error" });
      }
    },
  );

  for (const { path, read } of [
    { path: "/notifications/:id/read", read: true },
    { path: "/notifications/:id/unread", read: false },
  ]) {
    fastify.post(
      path,
      { preHandler: fastify.authenticate },
      async (request: FastifyRequest, reply: FastifyReply) => {
        const params = idParamsSchema.safeParse(request.params);
        if (!params.success) {
          return reply.status(400).send({
            error: "Invalid id",
            details: params.error.flatten(),
          });
        }

        try {
          const found = await setReadState(
            fastify.db,
            request.ownerId,
            params.data.id,
            read,
          );
          if (!found) {
            return reply.status(404).send({ error: "Notification not found" });
          }
          return reply.status(204).send();
        } catch (err) {
          request.log.error({ err, path }, "set read state failed");
          return reply.status(500).send({ error: "Internal server error" });
        }
      },
    );
  }

  fastify.get(
    "/notifications/preferences",
    { preHandler: fastify.authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        return reply.send(await getPreferences(fastify.db, request.ownerId));
      } catch (err) {
        request.log.error({ err }, "GET /notifications/preferences failed");
        return reply.status(500).send({ error: "Internal server error" });
      }
    },
  );

  fastify.put(
    "/notifications/preferences",
    { preHandler: fastify.authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = preferencesBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "Invalid preferences",
          details: parsed.error.flatten(),
        });
      }
      try {
        return reply.send(
          await upsertPreferences(
            fastify.db,
            request.ownerId,
            parsed.data,
            request.userEmail,
          ),
        );
      } catch (err) {
        request.log.error({ err }, "PUT /notifications/preferences failed");
        return reply.status(500).send({ error: "Internal server error" });
      }
    },
  );

  fastify.post(
    "/notifications/push-subscriptions",
    { preHandler: fastify.authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = pushSubscriptionSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "Invalid subscription",
          details: parsed.error.flatten(),
        });
      }
      try {
        await upsertSubscription(fastify.db, request.ownerId, {
          endpoint: parsed.data.endpoint,
          p256dh: parsed.data.keys.p256dh,
          auth: parsed.data.keys.auth,
          userAgent:
            parsed.data.userAgent ??
            (request.headers["user-agent"] as string) ??
            "",
        });
        return reply.status(204).send();
      } catch (err) {
        request.log.error(
          { err },
          "POST /notifications/push-subscriptions failed",
        );
        return reply.status(500).send({ error: "Internal server error" });
      }
    },
  );

  fastify.delete(
    "/notifications/push-subscriptions",
    { preHandler: fastify.authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = pushUnsubscribeSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "Invalid subscription",
          details: parsed.error.flatten(),
        });
      }
      try {
        await deleteSubscription(
          fastify.db,
          request.ownerId,
          parsed.data.endpoint,
        );
        return reply.status(204).send();
      } catch (err) {
        request.log.error(
          { err },
          "DELETE /notifications/push-subscriptions failed",
        );
        return reply.status(500).send({ error: "Internal server error" });
      }
    },
  );

  fastify.post(
    "/notifications/read-all",
    { preHandler: fastify.authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const updated = await markAllRead(fastify.db, request.ownerId);
        return reply.send({ updated });
      } catch (err) {
        request.log.error({ err }, "POST /notifications/read-all failed");
        return reply.status(500).send({ error: "Internal server error" });
      }
    },
  );
}
