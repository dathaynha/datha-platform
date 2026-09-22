import type { Pool } from "pg";
import { getMessage } from "./messages";

/**
 * Attachment access, brokered by this service.
 *
 * file-service is owner-scoped by design: every query filters on the
 * `X-Owner-ID` of the caller. That is right for a file manager and wrong for a
 * chat attachment — the person who needs to open it is usually *not* the person
 * who uploaded it. Conversation membership is the only correct authorization
 * here, and this service is the one that knows it.
 *
 * So the flow is: authorize the reader against the conversation, then ask
 * file-service for a short-lived download URL **as the uploader**, over the
 * private network. file-service stays chat-blind, and no ACL of conversation
 * ids leaks into it.
 */

export interface AttachmentTarget {
  fileId: string;
  /** The uploader — the only owner file-service will hand this blob to. */
  ownerId: string;
  /** Filename, carried in the message body (see design rules). */
  name: string;
  /** The sender's downscaled copy, when there is one. */
  thumbnailFileId: string | null;
  /** The original's pixel size, so a bubble can reserve its shape. */
  width: number | null;
  height: number | null;
}

export interface DownloadGrant {
  url: string;
  expiresAt: string;
}

/** The file-service call this needs, narrowed so tests need no HTTP server. */
export interface FileServiceClient {
  downloadUrl(fileId: string, ownerId: string): Promise<DownloadGrant>;
}

export class AttachmentNotFound extends Error {}

/**
 * Resolves the attachment of one message, having already established that the
 * caller may read the conversation.
 */
export async function resolveAttachment(
  db: Pool,
  params: { conversationId: string; messageId: string },
): Promise<AttachmentTarget> {
  const message = await getMessage(db, params);
  if (!message || message.deleted_at !== null) {
    throw new AttachmentNotFound("message not found");
  }
  if (!message.attachment_file_id) {
    throw new AttachmentNotFound("message has no attachment");
  }
  return {
    fileId: message.attachment_file_id,
    ownerId: message.sender_owner_id,
    name: message.body,
    thumbnailFileId: message.thumbnail_file_id,
    width: message.media_width,
    height: message.media_height,
  };
}

/** HTTP client for file-service's internal download-url route. */
export function createFileServiceClient(
  baseUrl: string,
  timeoutMs = 5_000,
): FileServiceClient {
  return {
    async downloadUrl(fileId: string, ownerId: string): Promise<DownloadGrant> {
      if (!baseUrl) {
        throw new Error("FILE_SERVICE_URL is not configured");
      }
      const response = await fetch(
        `${baseUrl}/files/${encodeURIComponent(fileId)}/download-url`,
        {
          // The uploader's identity, not the reader's: file-service scopes by
          // owner and this is a private-network call it is entitled to trust.
          headers: { "X-Owner-ID": ownerId },
          signal: AbortSignal.timeout(timeoutMs),
        },
      );

      if (response.status === 404) {
        throw new AttachmentNotFound("file not found");
      }
      if (!response.ok) {
        throw new Error(`file-service returned ${response.status}`);
      }

      const body = (await response.json()) as {
        sasDownloadUrl?: string;
        expiresAt?: string;
      };
      if (!body.sasDownloadUrl) {
        throw new Error("file-service returned no download url");
      }
      return {
        url: body.sasDownloadUrl,
        expiresAt: body.expiresAt ?? new Date().toISOString(),
      };
    },
  };
}
