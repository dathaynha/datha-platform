import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { config } from "../config";
import {
  getUserByOwnerId,
  lookupUsers,
  searchDirectory,
  syncUser,
} from "../services/users";
import { listWorkspacesForOwner } from "../services/workspaces";

const searchQuerySchema = z.object({
  q: z.string().max(200).default(""),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(config.DIRECTORY_MAX_RESULTS)
    .default(config.DIRECTORY_MAX_RESULTS),
});

const lookupQuerySchema = z.object({
  owner_ids: z
    .string()
    .min(1)
    .transform((v) =>
      v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.string().min(1)).max(100)),
});

/** Owner-scoped via gateway-injected X-Owner-ID (auth plugin) — no cross-owner access. */
export default async function usersRoutes(fastify: FastifyInstance) {
  // Called by the shell after login. Identity comes from gateway headers only,
  // never from the request body, so a client cannot claim another identity.
  fastify.post(
    "/users/me/sync",
    { preHandler: fastify.authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { profile, created } = await syncUser(fastify.db, {
          ownerId: request.ownerId,
          email: request.userEmail,
          name: request.userName,
          pictureUrl: request.userPicture,
          workspaceId: fastify.defaultWorkspaceId,
        });
        fastify.metrics.usersProvisioned.inc({
          outcome: created ? "created" : "updated",
        });
        const workspaces = await listWorkspacesForOwner(
          fastify.db,
          request.ownerId,
        );
        return reply.send({ data: { profile, workspaces, created } });
      } catch (err) {
        request.log.error({ err }, "POST /users/me/sync failed");
        return reply.status(500).send({ error: "Internal server error" });
      }
    },
  );

  fastify.get(
    "/users/me",
    { preHandler: fastify.authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const profile = await getUserByOwnerId(fastify.db, request.ownerId);
        if (!profile) {
          return reply.status(404).send({ error: "User not provisioned" });
        }
        const workspaces = await listWorkspacesForOwner(
          fastify.db,
          request.ownerId,
        );
        return reply.send({ data: { profile, workspaces } });
      } catch (err) {
        request.log.error({ err }, "GET /users/me failed");
        return reply.status(500).send({ error: "Internal server error" });
      }
    },
  );

  fastify.get(
    "/users/lookup",
    { preHandler: fastify.authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = lookupQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "Invalid query params",
          details: parsed.error.flatten(),
        });
      }
      try {
        const data = await lookupUsers(
          fastify.db,
          request.ownerId,
          parsed.data.owner_ids,
        );
        return reply.send({ data });
      } catch (err) {
        request.log.error({ err }, "GET /users/lookup failed");
        return reply.status(500).send({ error: "Internal server error" });
      }
    },
  );

  fastify.get(
    "/users",
    { preHandler: fastify.authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = searchQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "Invalid query params",
          details: parsed.error.flatten(),
        });
      }
      try {
        const data = await searchDirectory(fastify.db, {
          ownerId: request.ownerId,
          q: parsed.data.q,
          limit: parsed.data.limit,
        });
        return reply.send({ data });
      } catch (err) {
        request.log.error({ err }, "GET /users failed");
        return reply.status(500).send({ error: "Internal server error" });
      }
    },
  );
}
