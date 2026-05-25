import { describe, it, expect } from "vitest";
import { alertsBackoff, ALERTS_RETRY_DELAYS_MS } from "./queue";

describe("alertsBackoff", () => {
  it("returns 30s for the first retry", () => {
    expect(alertsBackoff(1)).toBe(30_000);
  });

  it("returns 2m for the second retry", () => {
    expect(alertsBackoff(2)).toBe(120_000);
  });

  it("returns 10m for the third retry", () => {
    expect(alertsBackoff(3)).toBe(600_000);
  });

  it("clamps to the last bucket for attemptsMade past the schedule length", () => {
    expect(alertsBackoff(4)).toBe(600_000);
    expect(alertsBackoff(99)).toBe(600_000);
  });

  it("clamps to the first bucket for attemptsMade <= 0", () => {
    expect(alertsBackoff(0)).toBe(30_000);
    expect(alertsBackoff(-1)).toBe(30_000);
  });

  it("ALERTS_RETRY_DELAYS_MS is exactly [30s, 2m, 10m]", () => {
    expect([...ALERTS_RETRY_DELAYS_MS]).toEqual([30_000, 120_000, 600_000]);
  });
});
