import type { MessageStreamEvent } from "@models/message-job.model";

import { MessageStreamService } from "./message-stream.service";

/** Minimal EventSource stand-in — lets a spec drive frames one at a time. */
class FakeEventSource {
  static last: FakeEventSource | null = null;

  onmessage: ((evt: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }

  close(): void {
    this.closed = true;
  }

  emit(payload: unknown): void {
    this.onmessage?.(
      new MessageEvent<string>("message", { data: JSON.stringify(payload) }),
    );
  }

  emitRaw(data: string): void {
    this.onmessage?.(new MessageEvent<string>("message", { data }));
  }

  fail(): void {
    this.onerror?.();
  }
}

describe("MessageStreamService", () => {
  let service: MessageStreamService;
  let original: typeof EventSource;

  const open = () => {
    const events: MessageStreamEvent[] = [];
    let completed = false;
    let errored: unknown = null;
    const sub = service.openStream("job-1", "tok en").subscribe({
      next: (e) => events.push(e),
      complete: () => (completed = true),
      error: (e: unknown) => (errored = e),
    });
    const es = FakeEventSource.last;
    if (!es) {
      throw new Error("EventSource was not constructed");
    }
    return {
      es,
      events,
      sub,
      state: () => ({ completed, errored }),
    };
  };

  beforeEach(() => {
    original = window.EventSource;
    FakeEventSource.last = null;
    (window as unknown as { EventSource: unknown }).EventSource =
      FakeEventSource;
    service = new MessageStreamService();
  });

  afterEach(() => {
    (window as unknown as { EventSource: unknown }).EventSource = original;
  });

  it("encodes the job id and stream token into the URL", () => {
    const { es, sub } = open();

    expect(es.url).toContain("/stream/job-1");
    expect(es.url).toContain("stream_token=tok%20en");
    sub.unsubscribe();
  });

  it("keeps the stream open on a retrying frame", () => {
    const { es, events, state, sub } = open();

    es.emit({ type: "claimed" });
    es.emit({ type: "retrying", attempt: 2, max_attempts: 3 });

    // The worker is still on this job — completing here would drop the reply.
    expect(state().completed).toBeFalse();
    expect(es.closed).toBeFalse();
    expect(events.map((e) => e.type)).toEqual(["claimed", "retrying"]);

    es.emit({ type: "chunk", text: "Hi" });
    es.emit({
      type: "done",
      assistant_message_id: "a-1",
      full_text: "Hi",
    });

    expect(state().completed).toBeTrue();
    expect(es.closed).toBeTrue();
    sub.unsubscribe();
  });

  it("completes and closes on done", () => {
    const { es, state, sub } = open();

    es.emit({ type: "done", assistant_message_id: "a-1", full_text: "x" });

    expect(state().completed).toBeTrue();
    expect(state().errored).toBeNull();
    expect(es.closed).toBeTrue();
    sub.unsubscribe();
  });

  it("emits the error frame then completes (the bubble is rendered from it)", () => {
    const { es, events, state, sub } = open();

    es.emit({ type: "error", error_summary: "boom" });

    expect(events.map((e) => e.type)).toEqual(["error"]);
    expect(state().completed).toBeTrue();
    expect(state().errored).toBeNull();
    sub.unsubscribe();
  });

  it("errors on an unparseable payload", () => {
    const { es, state, sub } = open();

    es.emitRaw("not json");

    expect(state().errored).toBeInstanceOf(Error);
    expect(es.closed).toBeTrue();
    sub.unsubscribe();
  });

  it("errors when the connection drops before done", () => {
    const { es, state, sub } = open();

    es.emit({ type: "claimed" });
    es.fail();

    expect(state().errored).toBeInstanceOf(Error);
    sub.unsubscribe();
  });

  it("stays quiet when the connection drops after done", () => {
    const { es, state, sub } = open();

    es.emit({ type: "done", assistant_message_id: "a-1", full_text: "x" });
    es.fail();

    expect(state().errored).toBeNull();
    sub.unsubscribe();
  });
});
