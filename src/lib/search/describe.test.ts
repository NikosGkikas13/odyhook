import { describe, it, expect } from "vitest";
import { describeEventQuery, describeFilterAst } from "./describe";
import type { EventQuery } from "./types";

describe("describeFilterAst", () => {
  it("renders leaf and boolean nodes", () => {
    expect(describeFilterAst({ endsWith: ["$.data.customer.email", "@gmail.com"] })).toMatch(/ends with "@gmail.com"/);
    expect(describeFilterAst({ and: [{ eq: ["$.type", "x"] }, { gt: ["$.n", 5] }] })).toMatch(/AND/);
    expect(describeFilterAst({ not: { eq: ["$.a", 1] } })).toMatch(/NOT/);
  });
});

describe("describeEventQuery", () => {
  it("builds chips for source, time, status, and payload", () => {
    const q: EventQuery = {
      metadata: {
        sourceId: "s1",
        receivedAfter: "2026-05-01T00:00:00.000Z",
        receivedBefore: "2026-06-01T00:00:00.000Z",
        status: ["failed", "exhausted"],
      },
      payload: { endsWith: ["$.email", "@gmail.com"] },
    };
    const chips = describeEventQuery(q, [{ id: "s1", name: "Stripe", slug: "stripe" }]);
    expect(chips.some((c) => /source: Stripe/.test(c))).toBe(true);
    expect(chips.some((c) => /failed/.test(c) && /exhausted/.test(c))).toBe(true);
    expect(chips.some((c) => /body:/.test(c) && /ends with/.test(c))).toBe(true);
    expect(chips.some((c) => /\d/.test(c))).toBe(true); // a date chip exists
  });

  it("returns an 'all events' chip when nothing is constrained", () => {
    const q: EventQuery = { metadata: { sourceId: null, receivedAfter: null, receivedBefore: null, status: null }, payload: null };
    expect(describeEventQuery(q, [])).toEqual(["all events"]);
  });
});
