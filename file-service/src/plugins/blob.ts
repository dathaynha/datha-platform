import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import { BlobServiceClient } from "@azure/storage-blob";
import { config } from "../config";

declare module "fastify" {
  interface FastifyInstance {
    blobServiceClient: BlobServiceClient;
  }
}

export default fp(
  async (fastify: FastifyInstance) => {
    const blobServiceClient = BlobServiceClient.fromConnectionString(
      config.AZURE_STORAGE_CONNECTION_STRING,
    );

    fastify.decorate("blobServiceClient", blobServiceClient);
  },
  { name: "blob" },
);
