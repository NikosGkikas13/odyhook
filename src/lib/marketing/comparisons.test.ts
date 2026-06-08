import { describe, it, expect } from "vitest";
import { COMPARISONS, getComparison } from "./comparisons";

describe("comparison data", () => {
  it("has hookdeck", () => {
    expect(COMPARISONS.map((c) => c.slug).sort()).toEqual(["hookdeck"]);
  });

  it("each comparison is fully populated", () => {
    for (const c of COMPARISONS) {
      expect(c.competitor.length).toBeGreaterThan(0);
      expect(c.asOf.length).toBeGreaterThan(0);
      expect(c.positioning.length).toBeGreaterThan(0);
      expect(c.features.length).toBeGreaterThan(5);
      expect(c.competitorStrengths.length).toBeGreaterThan(0);
      expect(c.pickOdyhookIf.length).toBeGreaterThan(0);
      expect(c.pickCompetitorIf.length).toBeGreaterThan(0);
      expect(c.sources.length).toBeGreaterThan(0);
    }
  });

  it("every feature row has both cells", () => {
    for (const c of COMPARISONS) {
      for (const row of c.features) {
        expect(row.capability.length).toBeGreaterThan(0);
        expect(["yes", "no", "partial"]).toContain(row.odyhook.value);
        expect(["yes", "no", "partial"]).toContain(row.competitor.value);
      }
    }
  });

  it("getComparison returns the matching record", () => {
    expect(getComparison("hookdeck")?.competitor).toBe("Hookdeck");
    expect(getComparison("nope")).toBeUndefined();
  });
});
