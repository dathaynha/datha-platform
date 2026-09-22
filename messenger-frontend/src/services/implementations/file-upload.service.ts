import { HttpClient, HttpContext, HttpHeaders } from "@angular/common/http";
import { Injectable, inject } from "@angular/core";
import { firstValueFrom } from "rxjs";
import { environment } from "src/environments/environment";
import {
  SKIP_ERROR_DIALOG_HEADER,
  SKIP_GLOBAL_ERROR_DIALOG,
} from "src/interceptors/http-context.tokens";
import type {
  FilePrepareRequest,
  FilePrepareResponse,
  FileRecordDto,
} from "src/models/file-service.model";

/** Tells file-service (and its orphan reconcile) which product owns the blob. */
export const MESSENGER_FILE_ORIGIN = "messenger";

/**
 * Attachment uploads, direct to Azure Blob.
 *
 * Three steps, as `services/file-service-architecture.md` prescribes: prepare
 * (metadata + a SAS URL), PUT the bytes straight to Blob, confirm. The bytes
 * never pass through the gateway or file-service, which is the whole point of
 * the SAS: a 50 MB attachment costs the platform no proxy bandwidth.
 */
@Injectable({ providedIn: "root" })
export class FileUploadService {
  private readonly http = inject(HttpClient);
  private readonly base = environment.gateway.filesBaseUrl;

  private readonly quiet = new HttpContext().set(
    SKIP_GLOBAL_ERROR_DIALOG,
    true,
  );
  private readonly quietHeaders = new HttpHeaders().set(
    SKIP_ERROR_DIALOG_HEADER,
    "1",
  );

  /**
   * Uploads a file and returns its id, ready to attach to a message.
   *
   * A failure at any step leaves at most a `pending` row in file-service, which
   * its own reconcile handles — so the caller can simply retry rather than
   * having to unwind anything.
   */
  async upload(file: File): Promise<string> {
    const body: FilePrepareRequest = {
      name: file.name,
      mimeType: file.type || "application/octet-stream",
      sizeBytes: file.size,
      origin: MESSENGER_FILE_ORIGIN,
    };
    const prepared = await firstValueFrom(
      this.http.post<FilePrepareResponse>(`${this.base}/prepare`, body, {
        context: this.quiet,
        headers: this.quietHeaders,
      }),
    );

    await this.putBlob(prepared.sasUploadUrl, file);

    await firstValueFrom(
      this.http.post<FileRecordDto>(
        `${this.base}/${encodeURIComponent(prepared.fileId)}/confirm`,
        {},
        { context: this.quiet, headers: this.quietHeaders },
      ),
    );

    return prepared.fileId;
  }

  /**
   * Single-shot PUT to Blob. `x-ms-blob-type` is required by the Azure REST
   * API; without it the upload fails with an unhelpful 400. Uses fetch rather
   * than HttpClient so the app's interceptors never see the SAS URL — it must
   * not have a bearer attached, and it must not be logged.
   */
  private async putBlob(sasUploadUrl: string, file: File): Promise<void> {
    const response = await fetch(sasUploadUrl, {
      method: "PUT",
      body: file,
      headers: {
        "x-ms-blob-type": "BlockBlob",
        "Content-Type": file.type || "application/octet-stream",
      },
    });
    if (!response.ok) {
      throw new Error(`blob upload failed: HTTP ${response.status}`);
    }
  }
}
