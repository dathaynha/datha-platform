import { provideHttpClient } from "@angular/common/http";
import {
  HttpTestingController,
  provideHttpClientTesting,
} from "@angular/common/http/testing";
import { TestBed, fakeAsync, tick } from "@angular/core/testing";
import type { PlatformNotification } from "@models/index";
import { environment } from "src/environments/environment";
import { NotificationsService } from "./notifications.service";

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  private readonly listeners = new Map<
    string,
    (event: MessageEvent<string>) => void
  >();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(
    type: string,
    listener: (event: MessageEvent<string>) => void,
  ): void {
    this.listeners.set(type, listener);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data: string): void {
    this.listeners.get(type)?.({ data } as MessageEvent<string>);
  }
}

function buildNotification(id: string): PlatformNotification {
  return {
    id,
    type: "file.cleanup",
    severity: "info",
    sourceService: "file-service",
    titleKey: "NOTIFICATIONS.FILE_CLEANUP.TITLE",
    bodyKey: "NOTIFICATIONS.FILE_CLEANUP.BODY",
    params: {},
    link: null,
    correlationId: null,
    readAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("NotificationsService", () => {
  const baseUrl = `${environment.gateway.baseUrl}/api/notifications`;
  let service: NotificationsService;
  let httpMock: HttpTestingController;
  let realEventSource: typeof EventSource;

  beforeEach(() => {
    realEventSource = globalThis.EventSource;
    (globalThis as { EventSource: unknown }).EventSource = FakeEventSource;
    FakeEventSource.instances = [];

    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(NotificationsService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    service.disconnect();
    (globalThis as { EventSource: unknown }).EventSource = realEventSource;
    httpMock.verify();
  });

  /** connect(), flush the token mint, and return the opened fake stream. */
  function openStream(count = 0): FakeEventSource {
    service.connect();
    httpMock
      .expectOne(`${baseUrl}/stream-token`)
      .flush({ stream_token: "tok-1" });
    tick();
    const source = FakeEventSource.instances.at(-1)!;
    source.onopen?.();
    httpMock.expectOne(`${baseUrl}/unread-count`).flush({ count });
    tick();
    return source;
  }

  it("opens the stream with the minted token and resyncs unread count", fakeAsync(() => {
    const source = openStream(2);
    expect(source.url).toContain("stream_token=tok-1");
    expect(service.unreadCount()).toBe(2);
  }));

  it("connect is idempotent — one stream per session", fakeAsync(() => {
    openStream();
    service.connect();
    expect(FakeEventSource.instances.length).toBe(1);
  }));

  it("pushed notification bumps the count, prepends to the list, and emits pushed$", fakeAsync(() => {
    const source = openStream(1);
    const emitted: PlatformNotification[] = [];
    service.pushed$.subscribe((n) => emitted.push(n));

    source.emit("notification", JSON.stringify(buildNotification("n1")));

    expect(service.unreadCount()).toBe(2);
    expect(service.notifications()[0]?.id).toBe("n1");
    expect(emitted.length).toBe(1);
  }));

  it("dedupes a push that already arrived via a list load — no count bump, no pushed$", fakeAsync(() => {
    const source = openStream(1);
    void service.loadNotifications();
    httpMock
      .expectOne((req) => req.url === baseUrl)
      .flush({ data: [buildNotification("n1")] });
    tick();
    const emitted: PlatformNotification[] = [];
    service.pushed$.subscribe((n) => emitted.push(n));

    source.emit("notification", JSON.stringify(buildNotification("n1")));

    expect(service.notifications().length).toBe(1);
    expect(service.unreadCount()).toBe(1);
    expect(emitted.length).toBe(0);
  }));

  it("ignores malformed stream payloads", fakeAsync(() => {
    const source = openStream();
    source.emit("notification", "not-json");
    expect(service.unreadCount()).toBe(0);
    expect(service.notifications().length).toBe(0);
  }));

  it("reconnects with a fresh token after a stream error", fakeAsync(() => {
    const source = openStream();

    source.onerror?.();
    expect(source.closed).toBeTrue();

    tick(1_000); // first backoff step
    httpMock
      .expectOne(`${baseUrl}/stream-token`)
      .flush({ stream_token: "tok-2" });
    tick();

    expect(FakeEventSource.instances.length).toBe(2);
    expect(FakeEventSource.instances[1]?.url).toContain("stream_token=tok-2");
  }));

  it("disconnect closes the stream and stops reconnecting", fakeAsync(() => {
    const source = openStream();

    service.disconnect();
    expect(source.closed).toBeTrue();

    tick(30_000); // no reconnect timer may fire
    httpMock.expectNone(`${baseUrl}/stream-token`);
  }));

  it("retries the token mint with backoff when it fails", fakeAsync(() => {
    service.connect();
    httpMock
      .expectOne(`${baseUrl}/stream-token`)
      .flush(null, { status: 503, statusText: "unavailable" });
    tick(1_000);
    httpMock
      .expectOne(`${baseUrl}/stream-token`)
      .flush({ stream_token: "tok-2" });
    tick();
    expect(FakeEventSource.instances.length).toBe(1);
  }));
});
