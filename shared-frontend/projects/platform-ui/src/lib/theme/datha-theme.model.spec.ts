import {
  DATHA_THEME_IDS,
  isDathaThemeId,
  normalizeDathaThemeId,
} from "./datha-theme.model";

describe("datha-theme.model", () => {
  describe("normalizeDathaThemeId", () => {
    it("passes through valid ids", () => {
      expect(normalizeDathaThemeId("starlight")).toBe("starlight");
      expect(normalizeDathaThemeId("midnight")).toBe("midnight");
    });

    it("maps legacy values", () => {
      expect(normalizeDathaThemeId("light")).toBe("starlight");
      expect(normalizeDathaThemeId("dark")).toBe("midnight");
      expect(normalizeDathaThemeId("aurora")).toBe("midnight");
    });

    it("falls back to starlight for unknown or missing values", () => {
      expect(normalizeDathaThemeId(null)).toBe("starlight");
      expect(normalizeDathaThemeId("")).toBe("starlight");
      expect(normalizeDathaThemeId("neon")).toBe("starlight");
    });
  });

  describe("isDathaThemeId", () => {
    it("accepts every declared id and rejects others", () => {
      for (const id of DATHA_THEME_IDS) {
        expect(isDathaThemeId(id)).toBeTrue();
      }
      expect(isDathaThemeId("dark")).toBeFalse();
    });
  });
});
