/**
 * Coalesces streamed text so the UI paints once per frame instead of once per chunk.
 *
 * SSE chunks arrive in TCP-sized bursts — dozens can land in a single frame, and on a
 * throttled link a stream replay delivers the whole backlog at once. Applying each chunk
 * on arrival means one signal update and one forced layout per chunk; batching per frame
 * keeps that at one of each, with no visible difference in how the text grows.
 */
export type FrameScheduler = (callback: () => void) => number;
export type FrameCanceller = (handle: number) => void;

export class StreamChunkBatcher {
  private readonly buffered = new Map<string, string>();
  private handle: number | null = null;

  constructor(
    private readonly apply: (batched: ReadonlyMap<string, string>) => void,
    private readonly schedule: FrameScheduler = (cb) =>
      requestAnimationFrame(cb),
    private readonly cancel: FrameCanceller = (h) => cancelAnimationFrame(h),
  ) {}

  /** Queues text for `key`, scheduling a flush if one is not already pending. */
  add(key: string, text: string): void {
    if (!text) {
      return;
    }
    this.buffered.set(key, (this.buffered.get(key) ?? "") + text);
    if (this.handle === null) {
      this.handle = this.schedule(() => {
        this.handle = null;
        this.drain();
      });
    }
  }

  /** Applies anything buffered right away — use before finalizing a message. */
  flushNow(): void {
    this.clearPendingFrame();
    this.drain();
  }

  /** Drops buffered text without applying it (thread switch, error, teardown). */
  cancelPending(): void {
    this.clearPendingFrame();
    this.buffered.clear();
  }

  private drain(): void {
    if (this.buffered.size === 0) {
      return;
    }
    const batch = new Map(this.buffered);
    this.buffered.clear();
    this.apply(batch);
  }

  private clearPendingFrame(): void {
    if (this.handle !== null) {
      this.cancel(this.handle);
      this.handle = null;
    }
  }
}
