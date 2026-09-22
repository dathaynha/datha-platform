import type {
  FileDownloadUrlResponse,
  FileListResponse,
  FilePrepareRequest,
  FilePrepareResponse,
  FileRecordDto,
} from "@models/file-service.model";
import type { Observable } from "rxjs";

/**
 * api-gateway → file-service: JWT on HttpClient calls except {@link putBlobViaSasUrl},
 * which must hit Azure directly without the app Bearer token.
 */
export interface IFileService {
  prepare(body: FilePrepareRequest): Observable<FilePrepareResponse>;

  confirm(fileId: string): Observable<FileRecordDto>;

  listFiles(limit?: number, offset?: number): Observable<FileListResponse>;

  deleteFile(fileId: string): Observable<void>;

  /**
   * PUT file bytes to the SAS URL from {@link prepare}.
   * Uses `fetch` so the auth interceptor never attaches Bearer to Azure Blob.
   * Sends `x-ms-blob-type: BlockBlob` as required by Azure Put Blob.
   */
  putBlobViaSasUrl(
    sasUploadUrl: string,
    body: Blob,
    contentType?: string,
  ): Observable<void>;

  /** SAS read URL for viewing/downloading; gateway forwards Bearer → injects X-Owner-ID. */
  getDownloadUrl(fileId: string): Observable<FileDownloadUrlResponse>;

  /** Full file bytes via gateway (same-origin); avoids Azure SAS `fetch` CORS for PDF.js thumbnails. */
  getFileContent(fileId: string): Observable<ArrayBuffer>;
}
