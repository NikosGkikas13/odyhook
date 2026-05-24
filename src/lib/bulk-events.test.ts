import { describe, it, expect } from "vitest";

import { parseBulkIds, BULK_MAX_IDS } from "./bulk-events";

describe("parseBulkIds", () => {
  it("accepts a valid ids array", () => {
    const r = parseBulkIds({ ids: ["a", "b", "c"] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ids).toEqual(["a", "b", "c"]);
  });

  it("dedupes repeated ids while preserving order", () => {
    const r = parseBulkIds({ ids: ["a", "b", "a", "c", "b"] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ids).toEqual(["a", "b", "c"]);
  });

  it("rejects a missing ids field", () => {
    const r = parseBulkIds({});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/ids/);
  });

  it("rejects an empty ids array", () => {
    const r = parseBulkIds({ ids: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/at least one/i);
  });

  it("rejects non-string entries", () => {
    const r = parseBulkIds({ ids: ["a", 123, "c"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/string/);
  });

  it("rejects more than BULK_MAX_IDS ids", () => {
    const tooMany = Array.from({ length: BULK_MAX_IDS + 1 }, (_, i) => `id${i}`);
    const r = parseBulkIds({ ids: tooMany });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/at most 50/i);
  });

  it("accepts exactly BULK_MAX_IDS ids", () => {
    const exactly = Array.from({ length: BULK_MAX_IDS }, (_, i) => `id${i}`);
    const r = parseBulkIds({ ids: exactly });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ids).toHaveLength(BULK_MAX_IDS);
  });

  it("rejects non-object input", () => {
    expect(parseBulkIds(null).ok).toBe(false);
    expect(parseBulkIds("string").ok).toBe(false);
    expect(parseBulkIds(42).ok).toBe(false);
    expect(parseBulkIds([]).ok).toBe(false);
  });

  it("BULK_MAX_IDS matches the documented cap of 50", () => {
    expect(BULK_MAX_IDS).toBe(50);
  });
});
