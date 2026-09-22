/**
 * Reduces an `RTCStatsReport` to the handful of numbers that distinguish the
 * remaining causes of unclear audio (phase 2.5 slice 0).
 *
 * Each field answers one specific question, which is the point — measuring
 * everything and eyeballing it is how you end up changing three constraints at
 * once and calling it fixed:
 *
 * - `codec` / `clockRate`: a narrowband path shows up here. 48000 is Opus doing
 *   its job; anything lower is the device or the negotiation.
 * - `packetsLost` / `jitter` / `concealment`: the network. Concealment is the
 *   receiver *inventing* audio to cover gaps, which is what "not clear"
 *   normally sounds like.
 * - `pair`: `relay` over TCP adds jitter that reads exactly like a bad mic —
 *   and colima forwards no UDP, so a local relay is always TCP.
 * - `capture`: what the browser actually applied, rather than what a bare
 *   `audio: true` is assumed to mean.
 */
export interface CallDiagnostics {
  codec: string;
  clockRate: number | null;
  packetsLost: number | null;
  jitter: number | null;
  concealment: number | null;
  /**
   * What this side is *sending*.
   *
   * `inbound-rtp` only measures what arrives here, so a one-directional
   * problem is invisible from the bad end. `audioLevel` on the source is the
   * one number that separates "my microphone is not picking me up" from
   * "the network dropped it" — near zero while speaking means capture.
   */
  outbound: {
    packetsSent: number | null;
    audioLevel: number | null;
  };
  pair: {
    local: string;
    remote: string;
    protocol: string;
    relayed: boolean;
  } | null;
  capture: {
    echoCancellation: boolean | null;
    noiseSuppression: boolean | null;
    autoGainControl: boolean | null;
  };
}

type Stat = Record<string, unknown>;

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/**
 * `report` is anything iterable of stat objects — the real `RTCStatsReport` is
 * a Map, which satisfies that without the DOM type being needed here.
 */
export function readDiagnostics(
  report: Iterable<[string, Stat]> | Iterable<Stat>,
): CallDiagnostics {
  const stats: Stat[] = [];
  for (const entry of report as Iterable<unknown>) {
    // A Map yields [id, stat]; a plain iterable yields the stat itself.
    stats.push(Array.isArray(entry) ? (entry[1] as Stat) : (entry as Stat));
  }

  const byId = new Map<string, Stat>();
  for (const stat of stats) {
    if (typeof stat["id"] === "string") byId.set(stat["id"], stat);
  }

  const inbound = stats.find(
    (s) => s["type"] === "inbound-rtp" && s["kind"] === "audio",
  );
  const source = stats.find((s) => s["type"] === "media-source");
  const outbound = stats.find(
    (s) => s["type"] === "outbound-rtp" && s["kind"] === "audio",
  );

  // Chrome marks the nominated pair with `selected`; the spec uses the
  // transport's `selectedCandidatePairId`. Accept either.
  const transport = stats.find((s) => s["type"] === "transport");
  const selectedId = transport?.["selectedCandidatePairId"];
  const pairStat =
    (typeof selectedId === "string" ? byId.get(selectedId) : undefined) ??
    stats.find(
      (s) =>
        s["type"] === "candidate-pair" &&
        (s["selected"] === true || s["state"] === "succeeded"),
    );

  const local =
    typeof pairStat?.["localCandidateId"] === "string"
      ? byId.get(pairStat["localCandidateId"])
      : undefined;
  const remote =
    typeof pairStat?.["remoteCandidateId"] === "string"
      ? byId.get(pairStat["remoteCandidateId"])
      : undefined;

  const codecStat =
    typeof inbound?.["codecId"] === "string"
      ? byId.get(inbound["codecId"])
      : undefined;

  return {
    codec:
      typeof codecStat?.["mimeType"] === "string"
        ? codecStat["mimeType"]
        : "unknown",
    clockRate: num(codecStat?.["clockRate"]),
    packetsLost: num(inbound?.["packetsLost"]),
    jitter: num(inbound?.["jitter"]),
    concealment: num(inbound?.["concealmentEvents"]),
    pair: pairStat
      ? {
          local: String(local?.["candidateType"] ?? "unknown"),
          remote: String(remote?.["candidateType"] ?? "unknown"),
          protocol: String(local?.["protocol"] ?? "unknown"),
          relayed:
            local?.["candidateType"] === "relay" ||
            remote?.["candidateType"] === "relay",
        }
      : null,
    outbound: {
      packetsSent: num(outbound?.["packetsSent"]),
      audioLevel: num(source?.["audioLevel"]),
    },
    capture: {
      echoCancellation: bool(source?.["echoCancellation"]),
      noiseSuppression: bool(source?.["noiseSuppression"]),
      autoGainControl: bool(source?.["autoGainControl"]),
    },
  };
}
