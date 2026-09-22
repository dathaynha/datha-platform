import { StreamChunkBatcher } from "./stream-chunk-batcher.helper";

describe("StreamChunkBatcher", () => {
  let frames: (() => void)[];
  let cancelled: number[];
  let applied: Map<string, string>[];
  let batcher: StreamChunkBatcher;

  beforeEach(() => {
    frames = [];
    cancelled = [];
    applied = [];
    batcher = new StreamChunkBatcher(
      (batch) => applied.push(new Map(batch)),
      (cb) => frames.push(cb) /* handle = length */,
      (h) => cancelled.push(h),
    );
  });

  function runFrame(): void {
    const cb = frames.shift();
    cb?.();
  }

  it("applies many chunks as one batch per frame", () => {
    batcher.add("a", "Hel");
    batcher.add("a", "lo ");
    batcher.add("a", "world");

    expect(applied.length).toBe(0);
    expect(frames.length).toBe(1); // one frame scheduled, not three

    runFrame();

    expect(applied.length).toBe(1);
    expect(applied[0].get("a")).toBe("Hello world");
  });

  it("schedules a fresh frame for chunks arriving after a flush", () => {
    batcher.add("a", "one");
    runFrame();
    batcher.add("a", "two");
    runFrame();

    expect(applied.map((b) => b.get("a"))).toEqual(["one", "two"]);
  });

  it("keeps separate keys apart in the same batch", () => {
    batcher.add("a", "first");
    batcher.add("b", "second");
    runFrame();

    expect(applied[0].get("a")).toBe("first");
    expect(applied[0].get("b")).toBe("second");
  });

  it("flushNow applies immediately and cancels the pending frame", () => {
    batcher.add("a", "partial");
    batcher.flushNow();

    expect(applied[0].get("a")).toBe("partial");
    expect(cancelled.length).toBe(1);

    runFrame(); // the cancelled frame must not double-apply
    expect(applied.length).toBe(1);
  });

  it("flushNow with nothing buffered does not apply an empty batch", () => {
    batcher.flushNow();
    expect(applied.length).toBe(0);
  });

  it("cancelPending drops buffered text", () => {
    batcher.add("a", "discard me");
    batcher.cancelPending();
    runFrame();

    expect(applied.length).toBe(0);
  });

  it("ignores empty chunks so no frame is scheduled", () => {
    batcher.add("a", "");

    expect(frames.length).toBe(0);
    expect(applied.length).toBe(0);
  });
});
