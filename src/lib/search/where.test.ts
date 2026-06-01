import { describe, it, expect } from "vitest";
import { buildEventWhere } from "./where";

describe("buildEventWhere", () => {
  it("always scopes to the user", () => {
    const w = buildEventWhere("u1", { sourceId: null, receivedAfter: null, receivedBefore: null, status: null });
    expect(w).toEqual({ source: { userId: "u1" } });
  });

  it("maps sourceId, time range, and status", () => {
    const w = buildEventWhere("u1", {
      sourceId: "s1",
      receivedAfter: "2026-05-01T00:00:00.000Z",
      receivedBefore: "2026-06-01T00:00:00.000Z",
      status: ["failed", "exhausted"],
    });
    expect(w.source).toEqual({ userId: "u1" });
    expect(w.sourceId).toBe("s1");
    expect(w.receivedAt).toEqual({
      gte: new Date("2026-05-01T00:00:00.000Z"),
      lt: new Date("2026-06-01T00:00:00.000Z"),
    });
    expect(w.deliveries).toEqual({ some: { status: { in: ["failed", "exhausted"] } } });
  });

  it("omits receivedAt when no bounds are set", () => {
    const w = buildEventWhere("u1", { sourceId: null, receivedAfter: "2026-05-01T00:00:00.000Z", receivedBefore: null, status: null });
    expect(w.receivedAt).toEqual({ gte: new Date("2026-05-01T00:00:00.000Z") });
  });
});
