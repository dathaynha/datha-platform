import { TestBed } from "@angular/core/testing";
import { provideHttpClient } from "@angular/common/http";
import {
  HttpTestingController,
  provideHttpClientTesting,
} from "@angular/common/http/testing";
import { environment } from "src/environments/environment";
import { SKIP_ERROR_DIALOG_HEADER } from "src/interceptors/http-context.tokens";
import {
  FileUploadService,
  MESSENGER_FILE_ORIGIN,
} from "./file-upload.service";

describe("FileUploadService", () => {
  let service: FileUploadService;
  let http: HttpTestingController;
  const base = environment.gateway.filesBaseUrl;
  const file = new File(["hello"], "spec.pdf", { type: "application/pdf" });

  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(FileUploadService);
    http = TestBed.inject(HttpTestingController);
  });

  it("prepares, PUTs the bytes to blob, then confirms", async () => {
    const fetchSpy = spyOn(window, "fetch").and.resolveTo(
      new Response(null, { status: 201 }),
    );

    const uploading = service.upload(file);

    await settle();
    const prepare = http.expectOne(`${base}/prepare`);
    expect(prepare.request.body).toEqual({
      name: "spec.pdf",
      mimeType: "application/pdf",
      sizeBytes: file.size,
      // file-service defaults origin to "chatbot", and its orphan reconcile
      // only deletes that origin — so a messenger upload must label itself.
      origin: MESSENGER_FILE_ORIGIN,
    });
    prepare.flush({
      fileId: "file-1",
      sasUploadUrl: "https://blob.example.com/spec.pdf?sig=abc",
    });

    await settle();
    const [url, init] = fetchSpy.calls.mostRecent().args as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://blob.example.com/spec.pdf?sig=abc");
    expect(init.method).toBe("PUT");
    // Required by the Azure Blob REST API; without it the PUT 400s.
    expect((init.headers as Record<string, string>)["x-ms-blob-type"]).toBe(
      "BlockBlob",
    );

    const confirm = http.expectOne(`${base}/file-1/confirm`);
    confirm.flush({ id: "file-1", name: "spec.pdf", status: "uploaded" });

    await expectAsync(uploading).toBeResolvedTo("file-1");
  });

  it("does not confirm when the blob upload fails", async () => {
    spyOn(window, "fetch").and.resolveTo(new Response(null, { status: 403 }));

    const uploading = service.upload(file);
    await settle();
    http.expectOne(`${base}/prepare`).flush({
      fileId: "file-1",
      sasUploadUrl: "https://blob.example.com/spec.pdf?sig=expired",
    });
    await settle();

    await expectAsync(uploading).toBeRejected();
    // Confirming a blob that never landed would mark a broken file uploaded.
    http.expectNone(`${base}/file-1/confirm`);
  });

  it("never sends the app's error dialog marker upstream to blob", async () => {
    const fetchSpy = spyOn(window, "fetch").and.resolveTo(
      new Response(null, { status: 201 }),
    );

    const uploading = service.upload(file);
    await settle();
    const prepare = http.expectOne(`${base}/prepare`);
    // Chat traffic is quiet: a failed upload shows inline, never as a modal.
    expect(prepare.request.headers.has(SKIP_ERROR_DIALOG_HEADER)).toBeTrue();
    prepare.flush({ fileId: "file-1", sasUploadUrl: "https://blob/x?sig=a" });

    await settle();
    const [, init] = fetchSpy.calls.mostRecent().args as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers[SKIP_ERROR_DIALOG_HEADER]).toBeUndefined();
    // The SAS URL must never carry a bearer either, which is why this one call
    // uses fetch and bypasses the interceptors entirely.
    expect(headers["Authorization"]).toBeUndefined();

    http.expectOne(`${base}/file-1/confirm`).flush({ id: "file-1" });
    await expectAsync(uploading).toBeResolved();
  });

  it("falls back to a generic mime type when the browser reports none", async () => {
    spyOn(window, "fetch").and.resolveTo(new Response(null, { status: 201 }));
    const typeless = new File(["x"], "notes", { type: "" });

    const uploading = service.upload(typeless);
    await settle();
    const prepare = http.expectOne(`${base}/prepare`);
    expect((prepare.request.body as { mimeType: string }).mimeType).toBe(
      "application/octet-stream",
    );
    prepare.flush({ fileId: "file-2", sasUploadUrl: "https://blob/y?sig=b" });

    await settle();
    http.expectOne(`${base}/file-2/confirm`).flush({ id: "file-2" });
    await expectAsync(uploading).toBeResolved();
  });
});
