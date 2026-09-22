import {
  HttpClientTestingModule,
  HttpTestingController,
} from "@angular/common/http/testing";
import { TestBed } from "@angular/core/testing";
import { DLQ_PAGE_SIZE } from "@constants/dlq.constant";
import { environment } from "src/environments/environment";

import { DlqService } from "./dlq.service";

describe("DlqService", () => {
  let service: DlqService;
  let http: HttpTestingController;
  const base = environment.gateway.baseUrl.replace(/\/$/, "");

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [DlqService],
    });
    service = TestBed.inject(DlqService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
  });

  it("lists DLQ records with snake_case query params", () => {
    service
      .list({
        sinks: ["file.conversation_cleanup"],
        correlationId: "corr-1",
        ownerId: "google_u1",
        from: "2026-01-01T00:00:00.000Z",
        to: "2026-01-02T00:00:00.000Z",
        limit: DLQ_PAGE_SIZE,
        offset: 10,
      })
      .subscribe((res) => {
        expect(res.total).toBe(1);
        expect(res.data[0].sink).toBe("file.conversation_cleanup");
      });

    const req = http.expectOne((r) => r.url === `${base}/dlq`);
    expect(req.request.method).toBe("GET");
    expect(req.request.params.getAll("sink")).toEqual([
      "file.conversation_cleanup",
    ]);
    expect(req.request.params.get("correlation_id")).toBe("corr-1");
    expect(req.request.params.get("owner_id")).toBe("google_u1");
    expect(req.request.params.get("from")).toBe("2026-01-01T00:00:00.000Z");
    expect(req.request.params.get("to")).toBe("2026-01-02T00:00:00.000Z");
    expect(req.request.params.get("limit")).toBe(String(DLQ_PAGE_SIZE));
    expect(req.request.params.get("offset")).toBe("10");

    req.flush({
      total: 1,
      data: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          subject: "events.dlq.file.conversation_cleanup",
          sink: "file.conversation_cleanup",
          originalSubject: "events.chatbot.conversation.deleted",
          ownerId: "google_u1",
          correlationId: "corr-1",
          lastError: "boom",
          failedAt: "2026-01-01T12:00:00.000Z",
          payload: {},
          envelope: { id: "22222222-2222-4222-8222-222222222222" },
          ingestedAt: "2026-01-01T12:01:00.000Z",
          replayedAt: null,
          jetstreamStream: "DLQ",
          jetstreamSequence: "7",
        },
      ],
    });
  });

  it("gets a single DLQ record by id", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    service.getById(id).subscribe((record) => {
      expect(record.id).toBe(id);
    });

    const req = http.expectOne(`${base}/dlq/${id}`);
    expect(req.request.method).toBe("GET");
    req.flush({ id, sink: "event_store.ingest" });
  });

  it("posts replay and skips the global error dialog", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    service.replay(id).subscribe((result) => {
      expect(result.originalSubject).toBe("events.file.file.deleted");
    });

    const req = http.expectOne(`${base}/dlq/${id}/replay`);
    expect(req.request.method).toBe("POST");
    expect(req.request.body).toBeNull();
    req.flush({
      id,
      originalSubject: "events.file.file.deleted",
      replayedAt: "2026-01-02T00:00:00.000Z",
    });
  });

  it("unwraps the distinct sink list", () => {
    let sinks: string[] | undefined;
    service.listSinks().subscribe((value) => (sinks = value));

    const req = http.expectOne(`${base}/dlq/sinks`);
    expect(req.request.method).toBe("GET");
    req.flush({ data: ["messenger_service.calls"] });

    expect(sinks).toEqual(["messenger_service.calls"]);
  });
});
