/** Request body for `POST /files/prepare` (via api-gateway). */
export interface FilePrepareRequest {
  name: string;
  mimeType?: string;
  sizeBytes?: number;
}

/** Response from file-service prepare — camelCase from Fastify. */
export interface FilePrepareResponse {
  fileId: string;
  sasUploadUrl: string;
}

export type FileRecordStatus = "pending" | "uploaded" | "deleted";

/** One file row as returned by list / confirm. */
export interface FileRecordDto {
  id: string;
  name: string;
  mimeType?: string | null;
  sizeBytes?: number | null;
  status: FileRecordStatus;
  createdAt: string;
  updatedAt: string;
}

export interface FileListResponse {
  data: FileRecordDto[];
  total: number;
}

/** GET /files/:id/download-url — camelCase from Fastify. */
export interface FileDownloadUrlResponse {
  sasDownloadUrl: string;
  expiresAt: string;
}
