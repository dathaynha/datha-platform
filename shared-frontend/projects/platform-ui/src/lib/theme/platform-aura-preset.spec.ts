import { platformAuraPreset } from "./platform-aura-preset";

describe("platformAuraPreset", () => {
  it("is a defined preset object", () => {
    expect(platformAuraPreset).toBeDefined();
    expect(typeof platformAuraPreset).toBe("object");
  });

  it("carries the platform primary ramp", () => {
    const primary = (platformAuraPreset as Record<string, any>)["semantic"]
      ?.primary;
    expect(primary).toBeDefined();
    expect(primary[500]).toBe("#e879f9");
    expect(primary[600]).toBe("#8514f5");
    expect(primary[950]).toBe("#1e1b4b");
  });

  it("extends Aura base semantics beyond the primary override", () => {
    const semantic = (platformAuraPreset as Record<string, any>)["semantic"];
    expect(semantic.focusRing).toBeDefined();
  });
});
