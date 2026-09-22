import {
  HttpClientTestingModule,
  HttpTestingController,
} from "@angular/common/http/testing";
import { TestBed } from "@angular/core/testing";
import { EVENTS_PAGE_SIZE } from "@constants/events.constant";
import { environment } from "src/environments/environment";

import { EventsService } from "./events.service";

describe("EventsService", () => {
  let service: EventsService;
  let http: HttpTestingController;
  const base = environment.gateway.baseUrl.replace(/\/$/, "");

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [EventsService],
    });
    service = TestBed.inject(EventsService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
  });

  it("lists events with snake_case query params", () => {
    service
      .list({
        types: ["file.uploaded"],
        services: ["file-service"],
        entityId: "ent-1",
        correlationId: "corr-1",
        ownerId: "google_u1",
        from: "2026-01-01T00:00:00.000Z",
        to: "2026-01-02T00:00:00.000Z",
        limit: EVENTS_PAGE_SIZE,
        offset: 10,
      })
      .subscribe((res) => {
        expect(res.total).toBe(1);
        expect(res.data[0].type).toBe("file.uploaded");
      });

    const req = http.expectOne((r) => r.url === `${base}/events`);
    expect(req.request.method).toBe("GET");
    expect(req.request.params.getAll("type")).toEqual(["file.uploaded"]);
    expect(req.request.params.getAll("service")).toEqual(["file-service"]);
    expect(req.request.params.get("entity_id")).toBe("ent-1");
    expect(req.request.params.get("correlation_id")).toBe("corr-1");
    expect(req.request.params.get("owner_id")).toBe("google_u1");
    expect(req.request.params.get("from")).toBe("2026-01-01T00:00:00.000Z");
    expect(req.request.params.get("to")).toBe("2026-01-02T00:00:00.000Z");
    expect(req.request.params.get("limit")).toBe(String(EVENTS_PAGE_SIZE));
    expect(req.request.params.get("offset")).toBe("10");

    req.flush({
      total: 1,
      data: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          type: "file.uploaded",
          service: "file-service",
          entityId: "ent-1",
          ownerId: "google_u1",
          correlationId: "corr-1",
          timestamp: "2026-01-01T12:00:00.000Z",
          payload: { size: 42 },
        },
      ],
    });
  });

  it("repeats service and type params for multi-select filters", () => {
    service
      .list({
        services: ["chatbot-service", "file-service"],
        types: ["file.uploaded", "chatbot.message.sent"],
      })
      .subscribe();

    const req = http.expectOne((r) => r.url === `${base}/events`);
    expect(req.request.params.getAll("service")).toEqual([
      "chatbot-service",
      "file-service",
    ]);
    expect(req.request.params.getAll("type")).toEqual([
      "file.uploaded",
      "chatbot.message.sent",
    ]);
    req.flush({ total: 0, data: [] });
  });

  it("gets a single event by id", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    service.getById(id).subscribe((event) => {
      expect(event.id).toBe(id);
      expect(event.type).toBe("file.uploaded");
    });

    const req = http.expectOne(`${base}/events/${id}`);
    expect(req.request.method).toBe("GET");
    req.flush({
      id,
      type: "file.uploaded",
      service: "file-service",
      entityId: "ent-1",
      ownerId: "google_u1",
      correlationId: "corr-1",
      timestamp: "2026-01-01T12:00:00.000Z",
      payload: { size: 42 },
    });
  });

  it("unwraps the distinct service list", () => {
    let services: string[] | undefined;
    service.listServices().subscribe((value) => (services = value));

    const req = http.expectOne(`${base}/events/services`);
    expect(req.request.method).toBe("GET");
    req.flush({ data: ["api-gateway", "realtime-service"] });

    expect(services).toEqual(["api-gateway", "realtime-service"]);
  });
});
