import { describe, it, expect } from "vitest";
import { encodeEventQuery, decodeEventQuery } from "./url";
import type { EventQuery } from "./types";

const q: EventQuery = {
  metadata: { sourceId: "s1", receivedAfter: "2026-05-01T00:00:00.000Z", receivedBefore: null, status: ["failed"] },
  payload: { endsWith: ["$.email", "@gmail.com"] },
};

describe("event query URL codec", () => {
  it("round-trips encode → decode", () => {
    expect(decodeEventQuery(encodeEventQuery(q))).toEqual(q);
  });

  it("decode validates (throws on garbage)", () => {
    expect(() => decodeEventQuery("not json")).toThrow(/malformed/i);
    expect(() => decodeEventQuery(JSON.stringify({ metadata: { status: ["nope"] } }))).toThrow();
  });
});
