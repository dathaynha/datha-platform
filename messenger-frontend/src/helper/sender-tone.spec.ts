import { SENDER_TONE_COUNT, senderTone } from "./sender-tone";

describe("senderTone", () => {
  it("is stable for the same owner", () => {
    expect(senderTone("google_1020390")).toBe(senderTone("google_1020390"));
  });

  it("stays inside the palette", () => {
    for (const id of ["a", "google_1", "google_999999999999999999", ""]) {
      const tone = senderTone(id);
      expect(tone).toBeGreaterThanOrEqual(0);
      expect(tone).toBeLessThan(SENDER_TONE_COUNT);
    }
  });

  /**
   * Every owner id on this platform starts `google_`, so a hash that reads
   * only the first characters puts the whole conversation on one colour —
   * which looks like it is working and carries no information at all.
   */
  it("spreads ids that share the platform's owner-id prefix", () => {
    const ids = Array.from({ length: 12 }, (_, i) => `google_10203904756${i}`);
    const used = new Set(ids.map(senderTone));
    expect(used.size).toBeGreaterThan(2);
  });
});
