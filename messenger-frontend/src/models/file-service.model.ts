/** Request body for `POST /files/prepare` (via api-gateway). */
export interface FilePrepareRequest {
  name: string;
  mimeType?: string;
  sizeBytes?: number;
  /**
   * Which product uploaded the blob. file-service defaults this to "chatbot",
   * and its orphan reconcile only ever deletes files with that origin — so a
   * messenger upload must say so, or it becomes a cleanup candidate.
   */
  origin?: string;
}

export interface FilePrepareResponse {
  fileId: string;
  sasUploadUrl: string;
}

export type FileRecordStatus = "pending" | "uploaded" | "deleted";

export interface FileRecordDto {
  id: string;
  name: string;
  mimeType?: string | null;
  sizeBytes?: number | null;
  status: FileRecordStatus;
  createdAt: string;
  updatedAt: string;
}

/** What messenger-service hands back for a message's attachment. */
export interface AttachmentGrant {
  name: string;
  downloadUrl: string;
  expiresAt: string;
  /**
   * The sender's downscaled copy, when there is one — what a thread paints.
   * Null for anything sent before thumbnails existed, and for non-images.
   */
  thumbnailUrl: string | null;
  /** The original's pixel size, so the bubble reserves its shape. */
  width: number | null;
  height: number | null;
}
