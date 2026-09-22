import { BlobSASPermissions, BlobServiceClient } from "@azure/storage-blob";
import { config } from "../config";

export interface SasService {
  generateUploadUrl: (blobPath: string) => Promise<string>;
  generateDownloadUrl: (
    blobPath: string,
  ) => Promise<{ url: string; expiresAt: Date }>;
  /** Removes the blob if present (safe for pending uploads that never reached Blob). */
  deleteBlob: (blobPath: string) => Promise<void>;
}

export function createSasService(
  blobServiceClient: BlobServiceClient,
): SasService {
  const containerClient = blobServiceClient.getContainerClient(
    config.AZURE_STORAGE_CONTAINER,
  );

  async function generateUploadUrl(blobPath: string): Promise<string> {
    const blobClient = containerClient.getBlockBlobClient(blobPath);
    return blobClient.generateSasUrl({
      permissions: BlobSASPermissions.parse("cw"),
      expiresOn: new Date(Date.now() + config.SAS_UPLOAD_TTL_SECONDS * 1000),
    });
  }

  async function generateDownloadUrl(
    blobPath: string,
  ): Promise<{ url: string; expiresAt: Date }> {
    const expiresOn = new Date(
      Date.now() + config.SAS_DOWNLOAD_TTL_SECONDS * 1000,
    );
    const blobClient = containerClient.getBlobClient(blobPath);
    const url = await blobClient.generateSasUrl({
      permissions: BlobSASPermissions.parse("r"),
      expiresOn,
    });
    return { url, expiresAt: expiresOn };
  }

  async function deleteBlob(blobPath: string): Promise<void> {
    const blobClient = containerClient.getBlockBlobClient(blobPath);
    await blobClient.deleteIfExists();
  }

  return { generateUploadUrl, generateDownloadUrl, deleteBlob };
}
