import type { BlobServiceClient } from "@azure/storage-blob";
import { Pool } from "pg";
import { v4 as uuidv4 } from "uuid";
import { FILE_ORIGIN_CHATBOT } from "../constants/origin";
import { config } from "../config";
import { FileRow } from "../types";

function notFound(): Error {
  return Object.assign(new Error("File not found"), { statusCode: 404 });
}

function forbidden(): Error {
  return Object.assign(new Error("Forbidden"), { statusCode: 403 });
}

function conflict(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 409 });
}

function badRequest(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 400 });
}

// ─── prepare ─────────────────────────────────────────────────────────────────

export interface PrepareFileParams {
  ownerId: string;
  name: string;
  mimeType?: string | null;
  sizeBytes?: number | null;
  correlationId?: string | null;
  origin?: string;
}

export async function prepareFile(
  db: Pool,
  params: PrepareFileParams,
  generateUploadUrl: (blobPath: string) => Promise<string>,
): Promise<{ fileId: string; sasUploadUrl: string }> {
  if (
    params.sizeBytes !== undefined &&
    params.sizeBytes !== null &&
    params.sizeBytes > config.MAX_UPLOAD_BYTES
  ) {
    throw badRequest(
      `File exceeds maximum size (${Math.round(config.MAX_UPLOAD_BYTES / (1024 * 1024))} MB)`,
    );
  }

  const fileId = uuidv4();
  const blobPath = `${params.ownerId}/${fileId}/${params.name}`;
  const origin = params.origin ?? FILE_ORIGIN_CHATBOT;

  await db.query(
    `INSERT INTO files (id, owner_id, name, mime_type, size_bytes, blob_path, status, correlation_id, origin)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8)`,
    [
      fileId,
      params.ownerId,
      params.name,
      params.mimeType ?? null,
      params.sizeBytes ?? null,
      blobPath,
      params.correlationId ?? null,
      origin,
    ],
  );

  const sasUploadUrl = await generateUploadUrl(blobPath);
  return { fileId, sasUploadUrl };
}

// ─── confirm ─────────────────────────────────────────────────────────────────

export async function confirmFile(
  db: Pool,
  fileId: string,
  ownerId: string,
): Promise<FileRow> {
  const { rows } = await db.query<FileRow>(
    `SELECT * FROM files WHERE id = $1 AND deleted_at IS NULL`,
    [fileId],
  );
  const file = rows[0];
  if (!file) throw notFound();
  if (file.owner_id !== ownerId) throw forbidden();
  if (file.status !== "pending")
    throw conflict("File is not in pending status");

  const { rows: updated } = await db.query<FileRow>(
    `UPDATE files SET status = 'uploaded', updated_at = now() WHERE id = $1 RETURNING *`,
    [fileId],
  );
  return updated[0];
}

// ─── download-url ─────────────────────────────────────────────────────────────

export async function getFileForDownload(
  db: Pool,
  fileId: string,
  ownerId: string,
): Promise<FileRow> {
  const { rows } = await db.query<FileRow>(
    `SELECT * FROM files WHERE id = $1 AND deleted_at IS NULL`,
    [fileId],
  );
  const file = rows[0];
  if (!file) throw notFound();
  if (file.owner_id !== ownerId) throw forbidden();
  if (file.status !== "uploaded") throw conflict("File is not yet available");
  return file;
}

/** Full blob bytes for same-origin browser previews (avoids Azure Blob CORS on fetch). */
export async function readUploadedFileBytes(
  db: Pool,
  blobServiceClient: BlobServiceClient,
  containerName: string,
  fileId: string,
  ownerId: string,
  maxBytes: number,
): Promise<{ buffer: Buffer; mimeType: string | null }> {
  const file = await getFileForDownload(db, fileId, ownerId);
  if (file.size_bytes != null && file.size_bytes > maxBytes) {
    throw badRequest(`File exceeds maximum size (${maxBytes} bytes)`);
  }

  const blobClient = blobServiceClient
    .getContainerClient(containerName)
    .getBlockBlobClient(file.blob_path);

  const props = await blobClient.getProperties();
  const remoteLen = Number(props.contentLength ?? 0);
  if (remoteLen > maxBytes) {
    throw badRequest(`File exceeds maximum size (${maxBytes} bytes)`);
  }

  const buffer = await blobClient.downloadToBuffer();
  if (buffer.length > maxBytes) {
    throw badRequest(`File exceeds maximum size (${maxBytes} bytes)`);
  }

  return { buffer, mimeType: file.mime_type };
}

// ─── list ─────────────────────────────────────────────────────────────────────

export async function listFiles(
  db: Pool,
  ownerId: string,
  limit: number,
  offset: number,
  origin?: string | null,
): Promise<{ data: FileRow[]; total: number }> {
  const originClause =
    origin != null && origin !== "" ? " AND origin = $4" : "";
  const listParams =
    origin != null && origin !== ""
      ? [ownerId, limit, offset, origin]
      : [ownerId, limit, offset];
  const countParams =
    origin != null && origin !== "" ? [ownerId, origin] : [ownerId];

  const [{ rows }, { rows: countRows }] = await Promise.all([
    db.query<FileRow>(
      `SELECT * FROM files
       WHERE owner_id = $1 AND deleted_at IS NULL${originClause}
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      listParams,
    ),
    db.query<{ count: string }>(
      `SELECT COUNT(*) FROM files WHERE owner_id = $1 AND deleted_at IS NULL${
        origin != null && origin !== "" ? " AND origin = $2" : ""
      }`,
      countParams,
    ),
  ]);

  return { data: rows, total: parseInt(countRows[0].count, 10) };
}

// ─── delete ───────────────────────────────────────────────────────────────────

export async function softDeleteFile(
  db: Pool,
  fileId: string,
  ownerId: string,
  deleteBlob: (blobPath: string) => Promise<void>,
): Promise<FileRow> {
  const { rows } = await db.query<FileRow>(
    `SELECT * FROM files WHERE id = $1 AND deleted_at IS NULL`,
    [fileId],
  );
  const file = rows[0];
  if (!file) throw notFound();
  if (file.owner_id !== ownerId) throw forbidden();

  await deleteBlob(file.blob_path);

  const { rows: updated } = await db.query<FileRow>(
    `UPDATE files
     SET status = 'deleted', deleted_at = now(), updated_at = now()
     WHERE id = $1 RETURNING *`,
    [fileId],
  );
  return updated[0];
}
