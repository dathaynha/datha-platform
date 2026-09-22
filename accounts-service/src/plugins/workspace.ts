import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import { config } from "../config";
import { ensureWorkspace } from "../services/workspaces";

declare module "fastify" {
  interface FastifyInstance {
    defaultWorkspaceId: string;
  }
}

/**
 * Phase 0 directory model: one shared workspace every signed-in user joins.
 * Created once at boot so the first sync of a fresh database still has a
 * workspace to join. See `.claude/docs/services/accounts-service-architecture.md`.
 */
export default fp(
  async (fastify: FastifyInstance) => {
    const workspace = await ensureWorkspace(
      fastify.db,
      config.DEFAULT_WORKSPACE_SLUG,
      config.DEFAULT_WORKSPACE_NAME,
    );
    fastify.decorate("defaultWorkspaceId", workspace.id);
    fastify.log.info(
      { slug: workspace.slug, id: workspace.id },
      "default workspace ready",
    );
  },
  { name: "workspace", dependencies: ["db"] },
);
