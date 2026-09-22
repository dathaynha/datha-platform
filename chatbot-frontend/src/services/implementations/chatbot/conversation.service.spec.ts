import { TestBed } from "@angular/core/testing";
import {
  provideHttpClient,
  withInterceptorsFromDi,
} from "@angular/common/http";
import {
  HttpTestingController,
  provideHttpClientTesting,
} from "@angular/common/http/testing";

import { ConversationService } from "./conversation.service";

describe("ConversationService.activeJob", () => {
  let service: ConversationService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        ConversationService,
        provideHttpClient(withInterceptorsFromDi()),
        provideHttpClientTesting(),
      ],
    });
    service = TestBed.inject(ConversationService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it("returns the running job so the thread can re-attach", () => {
    const job = {
      job_id: "job-1",
      user_message_id: "msg-1",
      status: "processing" as const,
      stream_token: "tok",
    };
    let received: unknown = "unset";

    service.activeJob("conv-1").subscribe((v) => (received = v));

    const req = http.expectOne((r) =>
      r.url.endsWith("/conversations/conv-1/active-job"),
    );
    expect(req.request.method).toBe("GET");
    req.flush(job);

    expect(received).toEqual(job);
  });

  it("maps a 204 (nothing generating) to null", () => {
    let received: unknown = "unset";

    service.activeJob("conv-1").subscribe((v) => (received = v));

    http
      .expectOne((r) => r.url.endsWith("/conversations/conv-1/active-job"))
      .flush(null, { status: 204, statusText: "No Content" });

    expect(received).toBeNull();
  });

  it("encodes the conversation id", () => {
    service.activeJob("a b/c").subscribe();

    const req = http.expectOne((r) => r.url.includes("active-job"));
    expect(req.request.url).toContain("a%20b%2Fc");
    req.flush(null, { status: 204, statusText: "No Content" });
  });
});

describe("ConversationService.retryLast", () => {
  let service: ConversationService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        ConversationService,
        provideHttpClient(withInterceptorsFromDi()),
        provideHttpClientTesting(),
      ],
    });
    service = TestBed.inject(ConversationService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it("posts the selected model and returns the re-queued job", () => {
    const job = {
      job_id: "job-2",
      correlation_id: "job-2",
      conversation_id: "conv-1",
      user_message_id: "msg-1",
      stream_token: "tok",
    };
    let received: unknown = "unset";

    service.retryLast("conv-1", "gemini-3.6-flash").subscribe((v) => {
      received = v;
    });

    const req = http.expectOne((r) =>
      r.url.endsWith("/conversations/conv-1/retry-last"),
    );
    expect(req.request.method).toBe("POST");
    expect(req.request.body).toEqual({ model: "gemini-3.6-flash" });
    req.flush(job);

    expect(received).toEqual(job);
  });

  it("sends an empty model so the server default applies", () => {
    service.retryLast("conv-1").subscribe();

    const req = http.expectOne((r) => r.url.includes("retry-last"));
    expect(req.request.body).toEqual({ model: "" });
    req.flush({});
  });

  it("encodes the conversation id", () => {
    service.retryLast("a b/c").subscribe();

    const req = http.expectOne((r) => r.url.includes("retry-last"));
    expect(req.request.url).toContain("a%20b%2Fc");
    req.flush({});
  });
});
