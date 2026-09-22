import {
  HttpClient,
  HttpContext,
  HttpHeaders,
  HttpParams,
} from "@angular/common/http";
import { Injectable } from "@angular/core";
import type {
  FileDownloadUrlResponse,
  FileListResponse,
  FilePrepareRequest,
  FilePrepareResponse,
  FileRecordDto,
} from "@models/file-service.model";
import type { IFileService } from "@services/interfaces/file-service/file-service.interface";
import { from, Observable } from "rxjs";
import {
  SKIP_ERROR_DIALOG_HEADER,
  SKIP_GLOBAL_ERROR_DIALOG,
} from "src/interceptors/http-context.tokens";
import { environment } from "src/environments/environment";

@Injectable()
export class FileService implements IFileService {
  /**
   * Quiet-errors marker in both forms. The context token works standalone;
   * the header is what survives Module Federation, because hosted by the shell
   * the interceptor that owns the dialog is the shell's and reads its own token
   * object. Without it a failed preview pops a modal over the chat.
   */
  private readonly quiet = new HttpContext().set(
    SKIP_GLOBAL_ERROR_DIALOG,
    true,
  );
  private readonly quietHeaders = new HttpHeaders().set(
    SKIP_ERROR_DIALOG_HEADER,
    "1",
  );

  constructor(private readonly http: HttpClient) {}

  private filesBase(): string {
    const base = environment.gateway?.filesBaseUrl?.replace(/\/$/, "");
    if (!base) {
      throw new Error("environment.gateway.filesBaseUrl is not set");
    }
    return base;
  }

  prepare(body: FilePrepareRequest): Observable<FilePrepareResponse> {
    const url = `${this.filesBase()}/prepare`;
    return this.http.post<FilePrepareResponse>(url, {
      name: body.name,
      mimeType: body.mimeType,
      sizeBytes: body.sizeBytes,
    });
  }

  confirm(fileId: string): Observable<FileRecordDto> {
    const url = `${this.filesBase()}/${encodeURIComponent(fileId)}/confirm`;
    return this.http.post<FileRecordDto>(url, {});
  }

  listFiles(limit = 20, offset = 0): Observable<FileListResponse> {
    const url = this.filesBase();
    const params = new HttpParams()
      .set("limit", String(limit))
      .set("offset", String(offset));
    return this.http.get<FileListResponse>(url, { params });
  }

  deleteFile(fileId: string): Observable<void> {
    const url = `${this.filesBase()}/${encodeURIComponent(fileId)}`;
    return this.http.delete<void>(url);
  }

  putBlobViaSasUrl(
    sasUploadUrl: string,
    body: Blob,
    contentType?: string,
  ): Observable<void> {
    const headers: Record<string, string> = {
      // Required by Azure Blob Put Blob REST API for single-shot upload (browser SAS PUT).
      "x-ms-blob-type": "BlockBlob",
    };
    if (contentType) {
      headers["Content-Type"] = contentType;
    }
    return from(
      fetch(sasUploadUrl, {
        method: "PUT",
        body,
        headers,
      }).then((res) => {
        if (!res.ok) {
          throw new Error(`Blob upload failed: HTTP ${res.status}`);
        }
      }),
    );
  }

  getDownloadUrl(fileId: string): Observable<FileDownloadUrlResponse> {
    const url = `${this.filesBase()}/${encodeURIComponent(fileId)}/download-url`;
    return this.http.get<FileDownloadUrlResponse>(url, {
      context: this.quiet,
      headers: this.quietHeaders,
    });
  }

  getFileContent(fileId: string): Observable<ArrayBuffer> {
    const url = `${this.filesBase()}/${encodeURIComponent(fileId)}/content`;
    return this.http.get(url, {
      responseType: "arraybuffer",
      context: this.quiet,
      headers: this.quietHeaders,
    });
  }
}
