import { DestroyRef, Injectable, InjectionToken, inject } from "@angular/core";

/**
 * Indirection over the Web Audio constructor so the unlock path is testable
 * without a real audio device.
 */
export const AUDIO_CONTEXT_FACTORY = new InjectionToken<
  () => AudioContext | null
>("AUDIO_CONTEXT_FACTORY", {
  providedIn: "root",
  factory: () => () => {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    return Ctor ? new Ctor() : null;
  },
});

/** Ringtone shape: two tones, then silence, repeating — a phone cadence. */
const RING_TONE_HZ = 480;
const RING_TONE_ALT_HZ = 620;
const RING_ON_MS = 800;
const RING_GAP_MS = 1_600;
/** Kept low: this plays unprompted, and a startling ring is worse than a quiet one. */
const RING_GAIN = 0.08;

/**
 * The incoming-call ringtone, and the gesture unlock it depends on.
 *
 * **Browsers block audio until the user has interacted with the page.** A call
 * arrives without any interaction of its own, so an `AudioContext` created at
 * that moment starts `suspended` and rings silently. The fix is to create and
 * resume one on the *first* click after load and keep it — which is why this
 * service installs a one-shot listener rather than waiting for the call.
 *
 * Synthesised rather than an audio file: no asset to ship, no decode step, and
 * a two-tone cadence is a handful of oscillator nodes.
 */
@Injectable({ providedIn: "root" })
export class RingAudioService {
  private readonly createContext = inject(AUDIO_CONTEXT_FACTORY);
  private readonly destroyRef = inject(DestroyRef);

  private context: AudioContext | null = null;
  private ringTimer: ReturnType<typeof setInterval> | null = null;
  private activeNodes: { osc: OscillatorNode; gain: GainNode }[] = [];
  private unlockListener: (() => void) | null = null;

  constructor() {
    this.destroyRef.onDestroy(() => this.dispose());
  }

  /**
   * Arms the unlock. Idempotent, and safe to call before login.
   *
   * The listener is registered `once` on both pointer and key input: a keyboard
   * user never produces a pointer event, and a call that rings silently for
   * them is the same bug.
   */
  armUnlock(): void {
    if (this.context || this.unlockListener) return;

    const unlock = () => {
      this.unlockListener = null;
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
      this.ensureContext();
    };
    this.unlockListener = unlock;
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
  }

  /** True once a context exists and is running — i.e. a ring will be audible. */
  get unlocked(): boolean {
    return this.context !== null && this.context.state === "running";
  }

  /**
   * Starts ringing, or does nothing if audio was never unlocked.
   *
   * Silence is an acceptable degradation: the dock is still on screen with an
   * accept button, so a missed *sound* is not a missed call.
   */
  startRinging(): void {
    const context = this.ensureContext();
    if (!context || this.ringTimer !== null) return;

    this.burst(context);
    this.ringTimer = setInterval(
      () => this.burst(context),
      RING_ON_MS + RING_GAP_MS,
    );
  }

  stopRinging(): void {
    if (this.ringTimer !== null) {
      clearInterval(this.ringTimer);
      this.ringTimer = null;
    }
    this.stopNodes();
  }

  /** Releases the audio device. Called on destroy; the context is not reusable. */
  dispose(): void {
    this.stopRinging();
    if (this.unlockListener) {
      window.removeEventListener("pointerdown", this.unlockListener);
      window.removeEventListener("keydown", this.unlockListener);
      this.unlockListener = null;
    }
    void this.context?.close().catch(() => undefined);
    this.context = null;
  }

  private ensureContext(): AudioContext | null {
    if (!this.context) {
      this.context = this.createContext();
    }
    // A context created before any gesture starts suspended, and resume() only
    // succeeds once one has happened — so this is retried rather than assumed.
    if (this.context?.state === "suspended") {
      void this.context.resume().catch(() => undefined);
    }
    return this.context;
  }

  /** One two-tone burst. Nodes are one-shot; Web Audio does not reuse them. */
  private burst(context: AudioContext): void {
    this.stopNodes();
    const now = context.currentTime;
    for (const [index, frequency] of [
      RING_TONE_HZ,
      RING_TONE_ALT_HZ,
    ].entries()) {
      const osc = context.createOscillator();
      const gain = context.createGain();
      osc.frequency.value = frequency;
      osc.type = "sine";
      // Ramped rather than switched: an abrupt gain change is an audible click.
      const start = now + index * (RING_ON_MS / 2_000);
      const stop = start + RING_ON_MS / 2_000;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(RING_GAIN, start + 0.02);
      gain.gain.linearRampToValueAtTime(0, stop);
      osc.connect(gain).connect(context.destination);
      osc.start(start);
      osc.stop(stop);
      this.activeNodes.push({ osc, gain });
    }
  }

  private stopNodes(): void {
    for (const { osc, gain } of this.activeNodes) {
      try {
        osc.stop();
      } catch {
        // Already stopped by its own scheduled stop time.
      }
      osc.disconnect();
      gain.disconnect();
    }
    this.activeNodes = [];
  }
}
