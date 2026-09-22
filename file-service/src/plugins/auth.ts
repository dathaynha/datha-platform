import fp from "fastify-plugin";
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (
      request: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<void>;
  }
  interface FastifyRequest {
    ownerId: string;
  }
}

export default fp(
  async (fastify: FastifyInstance) => {
    // Trust X-Owner-ID injected by api-gateway (or internal callers on a private network).
    // Gateway strips client-supplied values before forwarding — same model as chatbot-service.
    fastify.decorate(
      "authenticate",
      async (request: FastifyRequest, reply: FastifyReply) => {
        const ownerId = request.headers["x-owner-id"];
        if (!ownerId || typeof ownerId !== "string") {
          return reply.status(401).send({ error: "Missing X-Owner-ID header" });
        }
        request.ownerId = ownerId;
      },
    );
  },
  { name: "auth" },
);
