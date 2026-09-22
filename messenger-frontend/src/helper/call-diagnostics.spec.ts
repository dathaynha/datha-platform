import { readDiagnostics } from "./call-diagnostics";

/** A stats report shaped like Chrome's: a Map of id → stat object. */
function report(
  ...stats: Record<string, unknown>[]
): Map<string, Record<string, unknown>> {
  return new Map(stats.map((s) => [String(s["id"]), s]));
}

const CODEC = {
  id: "codec-1",
  type: "codec",
  mimeType: "audio/opus",
  clockRate: 48000,
};

const INBOUND = {
  id: "in-1",
  type: "inbound-rtp",
  kind: "audio",
  codecId: "codec-1",
  packetsLost: 12,
  jitter: 0.004,
  concealmentEvents: 7,
};

describe("readDiagnostics", () => {
  it("reports the negotiated codec and its clock rate", () => {
    // A narrowband path shows up here: 48000 is Opus working, anything lower
    // is the device or the negotiation.
    const stats = readDiagnostics(report(CODEC, INBOUND));

    expect(stats.codec).toBe("audio/opus");
    expect(stats.clockRate).toBe(48000);
  });

  it("reports loss, jitter and concealment", () => {
    // Concealment is the receiver inventing audio to cover gaps, which is what
    // "not clear" usually sounds like.
    const stats = readDiagnostics(report(CODEC, INBOUND));

    expect(stats.packetsLost).toBe(12);
    expect(stats.jitter).toBe(0.004);
    expect(stats.concealment).toBe(7);
  });

  it("follows the transport to the nominated candidate pair", () => {
    const stats = readDiagnostics(
      report(
        CODEC,
        INBOUND,
        { id: "t-1", type: "transport", selectedCandidatePairId: "pair-2" },
        {
          id: "pair-1",
          type: "candidate-pair",
          state: "succeeded",
          localCandidateId: "l-1",
          remoteCandidateId: "r-1",
        },
        {
          id: "pair-2",
          type: "candidate-pair",
          localCandidateId: "l-2",
          remoteCandidateId: "r-2",
        },
        {
          id: "l-1",
          type: "local-candidate",
          candidateType: "host",
          protocol: "udp",
        },
        { id: "r-1", type: "remote-candidate", candidateType: "host" },
        {
          id: "l-2",
          type: "local-candidate",
          candidateType: "relay",
          protocol: "tcp",
        },
        { id: "r-2", type: "remote-candidate", candidateType: "srflx" },
      ),
    );

    // The transport's choice wins over any pair merely marked succeeded.
    expect(stats.pair?.local).toBe("relay");
    expect(stats.pair?.protocol).toBe("tcp");
    expect(stats.pair?.relayed).toBeTrue();
  });

  it("falls back to a succeeded pair when no transport names one", () => {
    const stats = readDiagnostics(
      report(
        CODEC,
        INBOUND,
        {
          id: "pair-1",
          type: "candidate-pair",
          state: "succeeded",
          localCandidateId: "l-1",
          remoteCandidateId: "r-1",
        },
        {
          id: "l-1",
          type: "local-candidate",
          candidateType: "host",
          protocol: "udp",
        },
        { id: "r-1", type: "remote-candidate", candidateType: "host" },
      ),
    );

    expect(stats.pair?.relayed).toBeFalse();
    expect(stats.pair?.protocol).toBe("udp");
  });

  it("reports the capture settings the browser actually applied", () => {
    // `audio: true` leaves these to the browser, so the only honest way to
    // know what is on is to read them back.
    const stats = readDiagnostics(
      report(CODEC, INBOUND, {
        id: "src-1",
        type: "media-source",
        echoCancellation: true,
        noiseSuppression: false,
        autoGainControl: true,
      }),
    );

    expect(stats.capture.echoCancellation).toBeTrue();
    expect(stats.capture.noiseSuppression).toBeFalse();
    expect(stats.capture.autoGainControl).toBeTrue();
  });

  it("survives a report with nothing useful in it", () => {
    const stats = readDiagnostics(report());

    expect(stats.codec).toBe("unknown");
    expect(stats.pair).toBeNull();
    expect(stats.packetsLost).toBeNull();
    expect(stats.capture.echoCancellation).toBeNull();
  });
});
