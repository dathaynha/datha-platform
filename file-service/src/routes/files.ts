import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { FILE_ORIGIN_CHATBOT } from "../constants/origin";
import { config } from "../config";
import { createSasService } from "../services/sas.service";
import * as fileService from "../services/file.service";
import { publishEvent } from "../services/events.service";
import { FileRow } from "../types";

function toResponse(file: FileRow) {
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mime_type,
    sizeBytes: file.size_bytes,
    status: file.status,
    createdAt: file.created_at.toISOString(),
    updatedAt: file.updated_at.toISOString(),
  };
}

function handleError(err: unknown, reply: FastifyReply) {
  const e = err as { statusCode?: number; message?: string };
  return reply
    .status(e.statusCode ?? 500)
    .send({ error: e.message ?? "Internal server error" });
}

// ─── validation schemas ───────────────────────────────────────────────────────

const prepareBodySchema = z.object({
  name: z.string().min(1).max(512),
  mimeType: z.string().optional(),
  sizeBytes: z.number().int().positive().optional(),
  origin: z.string().min(1).max(64).optional(),
});

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  origin: z.string().min(1).max(64).optional(),
});

function resolvePrepareOrigin(
  bodyOrigin: string | undefined,
  callingService: string | undefined,
): string {
  if (bodyOrigin) {
    return bodyOrigin;
  }
  if (callingService === "chatbot-service") {
    return FILE_ORIGIN_CHATBOT;
  }
  return FILE_ORIGIN_CHATBOT;
}

// ─── routes ───────────────────────────────────────────────────────────────────

export default async function fileRoutes(fastify: FastifyInstance) {
  const sas = createSasService(fastify.blobServiceClient);

  // POST /files/prepare
  // Creates a pending file record and returns a SAS URL for direct Azure Blob upload.
  fastify.post(
    "/files/prepare",
    { preHandler: [fastify.authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = prepareBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "Invalid request body",
          details: parsed.error.flatten(),
        });
      }

      const correlationId = request.headers["x-correlation-id"] as
        string | undefined;
      const callingService = request.headers["x-calling-service"] as
        string | undefined;

      try {
        const result = await fileService.prepareFile(
          fastify.db,
          {
            ownerId: request.ownerId,
            name: parsed.data.name,
            mimeType: parsed.data.mimeType,
            sizeBytes: parsed.data.sizeBytes,
            correlationId,
            origin: resolvePrepareOrigin(parsed.data.origin, callingService),
          },
          sas.generateUploadUrl,
        );
        return reply.status(201).send(result);
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  // POST /files/:id/confirm
  // Marks the file as uploaded after the client has PUT bytes to Azure Blob.
  fastify.post<{ Params: { id: string } }>(
    "/files/:id/confirm",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      try {
        const file = await fileService.confirmFile(
          fastify.db,
          request.params.id,
          request.ownerId,
        );

        publishEvent(fastify.js, {
          type: "file.uploaded",
          fileId: file.id,
          ownerId: file.owner_id,
          mimeType: file.mime_type,
          blobPath: file.blob_path,
          correlationId: file.correlation_id,
          origin: file.origin,
        }).catch((err) =>
          fastify.log.error({ err }, "Failed to publish file.uploaded event"),
        );

        return reply.send(toResponse(file));
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  // GET /files/:id/content
  // Same-origin blob proxy for in-app previews (PDF.js etc.) via api-gateway.
  fastify.get<{ Params: { id: string } }>(
    "/files/:id/content",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      try {
        const { buffer, mimeType } = await fileService.readUploadedFileBytes(
          fastify.db,
          fastify.blobServiceClient,
          config.AZURE_STORAGE_CONTAINER,
          request.params.id,
          request.ownerId,
          config.MAX_UPLOAD_BYTES,
        );
        const ct =
          (mimeType ?? "").split(";")[0].trim() || "application/octet-stream";
        reply.header("Cache-Control", "private, max-age=60");
        return reply.type(ct).send(buffer);
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  // GET /files/:id/download-url
  // Internal/worker SAS URL — X-Owner-ID only. Do not expose through api-gateway.
  fastify.get<{ Params: { id: string } }>(
    "/files/:id/download-url",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      try {
        const file = await fileService.getFileForDownload(
          fastify.db,
          request.params.id,
          request.ownerId,
        );
        const { url, expiresAt } = await sas.generateDownloadUrl(
          file.blob_path,
        );
        return reply.send({
          sasDownloadUrl: url,
          expiresAt: expiresAt.toISOString(),
        });
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  // GET /files — browser via api-gateway (gateway validates JWT, injects X-Owner-ID).
  const listFilesHandler = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid query params",
        details: parsed.error.flatten(),
      });
    }

    try {
      const { data, total } = await fileService.listFiles(
        fastify.db,
        request.ownerId,
        parsed.data.limit,
        parsed.data.offset,
        parsed.data.origin,
      );
      return reply.send({ data: data.map(toResponse), total });
    } catch (err) {
      return handleError(err, reply);
    }
  };

  fastify.get(
    "/files",
    { preHandler: [fastify.authenticate] },
    listFilesHandler,
  );

  // GET /internal/files — orphan reconcile (private network only).
  fastify.get(
    "/internal/files",
    { preHandler: [fastify.authenticate] },
    listFilesHandler,
  );

  // DELETE /files/:id
  // Soft-deletes the file row after removing the blob from Azure (best-effort composer cleanup).
  fastify.delete<{ Params: { id: string } }>(
    "/files/:id",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      try {
        const file = await fileService.softDeleteFile(
          fastify.db,
          request.params.id,
          request.ownerId,
          sas.deleteBlob,
        );

        publishEvent(fastify.js, {
          type: "file.deleted",
          fileId: file.id,
          ownerId: file.owner_id,
          mimeType: file.mime_type,
          blobPath: file.blob_path,
          correlationId: file.correlation_id,
          origin: file.origin,
        }).catch((err) =>
          fastify.log.error({ err }, "Failed to publish file.deleted event"),
        );

        return reply.status(204).send();
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );
}
