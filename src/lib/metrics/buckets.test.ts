import { describe, it, expect } from "vitest";

import { granularityFor, zeroFill, windowStart } from "./buckets";
import type { BucketGranularity } from "./types";

describe("granularityFor", () => {
  it("returns 1-minute buckets for 1h window", () => {
    expect(granularityFor("1h")).toEqual({ granularity: "minute", multiple: 1 });
  });

  it("returns 15-minute buckets for 24h window", () => {
    expect(granularityFor("24h")).toEqual({ granularity: "minute", multiple: 15 });
  });

  it("returns 1-hour buckets for 7d window", () => {
    expect(granularityFor("7d")).toEqual({ granularity: "hour", multiple: 1 });
  });

  it("returns 6-hour buckets for 30d window", () => {
    expect(granularityFor("30d")).toEqual({ granularity: "hour", multiple: 6 });
  });
});

describe("windowStart", () => {
  it("returns now - 1h for a 1h window", () => {
    const now = new Date("2026-05-27T12:00:00Z");
    expect(windowStart("1h", now)).toEqual(new Date("2026-05-27T11:00:00Z"));
  });

  it("returns now - 24h for a 24h window", () => {
    const now = new Date("2026-05-27T12:00:00Z");
    expect(windowStart("24h", now)).toEqual(new Date("2026-05-26T12:00:00Z"));
  });

  it("returns now - 7d for a 7d window", () => {
    const now = new Date("2026-05-27T12:00:00Z");
    expect(windowStart("7d", now)).toEqual(new Date("2026-05-20T12:00:00Z"));
  });

  it("returns now - 30d for a 30d window", () => {
    const now = new Date("2026-05-27T12:00:00Z");
    expect(windowStart("30d", now)).toEqual(new Date("2026-04-27T12:00:00Z"));
  });
});

describe("zeroFill", () => {
  const spec = { granularity: "minute" as BucketGranularity, multiple: 15 };
  const start = new Date("2026-05-27T11:00:00Z");
  const end = new Date("2026-05-27T12:00:00Z");

  it("fills empty buckets, inclusive of the current in-progress bucket", () => {
    const result = zeroFill<{ count: number }>(
      [],
      start,
      end,
      spec,
      { count: 0 },
    );
    // 11:00, 11:15, 11:30, 11:45, 12:00 — the trailing 12:00 bucket is the
    // current-in-progress one and is included so live events still show up.
    expect(result).toHaveLength(5);
    expect(result.every((r) => r.count === 0)).toBe(true);
    expect(result[0].bucket).toEqual(new Date("2026-05-27T11:00:00Z"));
    expect(result[4].bucket).toEqual(new Date("2026-05-27T12:00:00Z"));
  });

  it("preserves provided rows and fills gaps around them", () => {
    const result = zeroFill<{ count: number }>(
      [{ bucket: new Date("2026-05-27T11:15:00Z"), count: 42 }],
      start,
      end,
      spec,
      { count: 0 },
    );
    expect(result).toHaveLength(5);
    expect(result[0].count).toBe(0);
    expect(result[1].count).toBe(42);
    expect(result[2].count).toBe(0);
    expect(result[3].count).toBe(0);
    expect(result[4].count).toBe(0);
  });

  it("aligns the first bucket to the granularity floor", () => {
    // start is mid-bucket (11:07) -> first bucket should snap back to 11:00.
    const result = zeroFill<{ count: number }>(
      [],
      new Date("2026-05-27T11:07:00Z"),
      new Date("2026-05-27T11:35:00Z"),
      spec,
      { count: 0 },
    );
    expect(result[0].bucket).toEqual(new Date("2026-05-27T11:00:00Z"));
  });
});
