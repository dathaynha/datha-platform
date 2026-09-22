import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import { Pool } from "pg";
import { config } from "../config";

declare module "fastify" {
  interface FastifyInstance {
    db: Pool;
  }
}

export default fp(
  async (fastify: FastifyInstance) => {
    const pool = new Pool({ connectionString: config.DATABASE_URL });

    const client = await pool.connect();
    client.release();

    fastify.decorate("db", pool);

    fastify.addHook("onClose", async () => {
      await pool.end();
    });
  },
  { name: "db" },
);
