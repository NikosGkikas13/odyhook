import { describe, it, expect } from "vitest";
import { backoffForAttempt, MAX_ATTEMPTS, RETRY_DELAYS_MS } from "./queue";

describe("backoffForAttempt", () => {
  // attempt is the 1-indexed number of the attempt that just failed, matching
  // `delivery.attemptCount + 1` at the worker call site.
  it("returns 10s for the first retry (after attempt 1 fails)", () => {
    expect(backoffForAttempt(1)).toBe(10_000);
  });

  it("returns 30s for the second retry", () => {
    expect(backoffForAttempt(2)).toBe(30_000);
  });

  it("returns 2m for the third retry", () => {
    expect(backoffForAttempt(3)).toBe(120_000);
  });

  it("returns 10m for the fourth retry", () => {
    expect(backoffForAttempt(4)).toBe(600_000);
  });

  it("returns 1h for the fifth retry", () => {
    expect(backoffForAttempt(5)).toBe(3_600_000);
  });

  it("returns 6h for the sixth (final) retry", () => {
    expect(backoffForAttempt(6)).toBe(21_600_000);
  });

  it("clamps to the last bucket past the schedule length", () => {
    expect(backoffForAttempt(7)).toBe(21_600_000);
    expect(backoffForAttempt(99)).toBe(21_600_000);
  });

  it("clamps to the first bucket for attempt <= 0", () => {
    expect(backoffForAttempt(0)).toBe(10_000);
    expect(backoffForAttempt(-1)).toBe(10_000);
  });
});

describe("RETRY_DELAYS_MS / MAX_ATTEMPTS", () => {
  it("is exactly [10s, 30s, 2m, 10m, 1h, 6h]", () => {
    expect([...RETRY_DELAYS_MS]).toEqual([
      10_000,
      30_000,
      120_000,
      600_000,
      3_600_000,
      21_600_000,
    ]);
  });

  it("allows 7 attempts total: 1 initial + 6 retries (one per delay)", () => {
    expect(MAX_ATTEMPTS).toBe(7);
    expect(MAX_ATTEMPTS).toBe(RETRY_DELAYS_MS.length + 1);
  });
});
