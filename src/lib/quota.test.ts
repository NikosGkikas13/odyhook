import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { countMock } = vi.hoisted(() => ({ countMock: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    source: { count: countMock },
    destination: { count: countMock },
    route: { count: countMock },
    apiToken: { count: countMock },
  },
}));

import { assertWithinQuota, quotaLimit, QuotaExceededError } from "./quota";

describe("quotaLimit", () => {
  afterEach(() => {
    delete process.env.MAX_ROUTES_PER_USER;
  });

  it("reads the env override", () => {
    process.env.MAX_ROUTES_PER_USER = "7";
    expect(quotaLimit("routes")).toBe(7);
  });

  it("falls back to a default for an unset/invalid value", () => {
    delete process.env.MAX_ROUTES_PER_USER;
    expect(quotaLimit("routes")).toBeGreaterThan(0);
    process.env.MAX_ROUTES_PER_USER = "-5";
    expect(quotaLimit("routes")).toBeGreaterThan(0);
  });
});

describe("assertWithinQuota", () => {
  beforeEach(() => {
    countMock.mockReset();
    process.env.MAX_SOURCES_PER_USER = "3";
  });
  afterEach(() => {
    delete process.env.MAX_SOURCES_PER_USER;
  });

  it("resolves when under the limit", async () => {
    countMock.mockResolvedValue(2);
    await expect(assertWithinQuota("u1", "sources")).resolves.toBeUndefined();
  });

  it("throws QuotaExceededError at the limit", async () => {
    countMock.mockResolvedValue(3);
    await expect(assertWithinQuota("u1", "sources")).rejects.toBeInstanceOf(
      QuotaExceededError,
    );
  });

  it("the error names the resource and limit", async () => {
    countMock.mockResolvedValue(99);
    const err = await assertWithinQuota("u1", "sources").catch((e) => e);
    expect(err).toBeInstanceOf(QuotaExceededError);
    expect(err.resource).toBe("sources");
    expect(err.limit).toBe(3);
  });
});
