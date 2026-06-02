import { describe, it, expect } from "vitest";
import { validateEventQuery } from "./types";

const base = {
  metadata: { sourceId: null, receivedAfter: null, receivedBefore: null, status: null },
  payload: null,
};

describe("validateEventQuery", () => {
  it("accepts a fully-null metadata query", () => {
    expect(validateEventQuery(base)).toEqual(base);
  });

  it("normalizes timestamps to ISO and keeps a valid payload", () => {
    const q = validateEventQuery({
      metadata: {
        sourceId: "src_1",
        receivedAfter: "2026-05-01T00:00:00.000Z",
        receivedBefore: "2026-06-01T00:00:00.000Z",
        status: ["failed", "exhausted"],
      },
      payload: { endsWith: ["$.email", "@gmail.com"] },
    });
    expect(q.metadata.receivedAfter).toBe("2026-05-01T00:00:00.000Z");
    expect(q.metadata.status).toEqual(["failed", "exhausted"]);
    expect(q.payload).toEqual({ endsWith: ["$.email", "@gmail.com"] });
  });

  it("normalizes an empty status array to null", () => {
    expect(validateEventQuery({ ...base, metadata: { ...base.metadata, status: [] } }).metadata.status).toBeNull();
  });

  it("throws on an unparseable date", () => {
    expect(() => validateEventQuery({ ...base, metadata: { ...base.metadata, receivedAfter: "not-a-date" } })).toThrow(/date/i);
  });

  it("throws on an unknown status value", () => {
    expect(() => validateEventQuery({ ...base, metadata: { ...base.metadata, status: ["nope"] } })).toThrow(/status/i);
  });

  it("throws on a malformed payload AST", () => {
    expect(() => validateEventQuery({ ...base, payload: { bogus: true } })).toThrow(/unknown filter node/i);
  });

  it("throws on a non-object input", () => {
    expect(() => validateEventQuery(null)).toThrow();
    expect(() => validateEventQuery(42)).toThrow();
  });
});
