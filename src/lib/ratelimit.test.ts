import { describe, it, expect, vi, beforeEach } from "vitest";

// Control the Redis connection so we can force the primary limiter to fail and
// exercise the in-process fallback. getConnection is lazy, so this never
// touches real Redis.
const { getConnMock } = vi.hoisted(() => ({ getConnMock: vi.fn() }));
vi.mock("./queue", () => ({ getConnection: getConnMock }));

import {
  checkFallbackLimit,
  checkApiRateLimit,
  type RateLimitConfig,
} from "./ratelimit";

const cfg: RateLimitConfig = { refillPerSec: 1, capacity: 3 };

describe("checkFallbackLimit (Redis-independent backstop)", () => {
  it("allows up to capacity, then blocks with a retry hint", () => {
    const key = `k-${Math.random()}`;
    const t0 = 1_000_000;
    expect(checkFallbackLimit(key, cfg, t0).allowed).toBe(true);
    expect(checkFallbackLimit(key, cfg, t0).allowed).toBe(true);
    expect(checkFallbackLimit(key, cfg, t0).allowed).toBe(true);
    const blocked = checkFallbackLimit(key, cfg, t0);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it("refills over time", () => {
    const key = `k-${Math.random()}`;
    const t0 = 2_000_000;
    for (let i = 0; i < 3; i++) checkFallbackLimit(key, cfg, t0);
    expect(checkFallbackLimit(key, cfg, t0).allowed).toBe(false);
    // 1s later one token has refilled (1/s).
    expect(checkFallbackLimit(key, cfg, t0 + 1000).allowed).toBe(true);
  });

  it("isolates buckets by key", () => {
    const t0 = 3_000_000;
    const a = `a-${Math.random()}`;
    const b = `b-${Math.random()}`;
    for (let i = 0; i < 3; i++) checkFallbackLimit(a, cfg, t0);
    expect(checkFallbackLimit(a, cfg, t0).allowed).toBe(false);
    expect(checkFallbackLimit(b, cfg, t0).allowed).toBe(true);
  });
});

describe("consumeToken falls back (not open) when Redis fails", () => {
  beforeEach(() => getConnMock.mockReset());

  it("does not throw and still enforces a limit when Redis is unavailable", async () => {
    getConnMock.mockReturnValue({
      eval: () => Promise.reject(new Error("redis down")),
    });
    const key = `tok-${Math.random()}`;
    const small: RateLimitConfig = { refillPerSec: 0.0001, capacity: 2 };
    const r1 = await checkApiRateLimit(key, small);
    const r2 = await checkApiRateLimit(key, small);
    const r3 = await checkApiRateLimit(key, small);
    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(true);
    expect(r3.allowed).toBe(false); // backstop engaged — NOT fail-open
  });

  it("uses Redis normally when it works", async () => {
    getConnMock.mockReturnValue({ eval: vi.fn().mockResolvedValue([1, "9", 0]) });
    const r = await checkApiRateLimit(`ok-${Math.random()}`);
    expect(r.allowed).toBe(true);
  });
});
