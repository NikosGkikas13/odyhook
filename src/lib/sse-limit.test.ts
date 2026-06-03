import { describe, it, expect } from "vitest";

import { acquireSseSlot, releaseSseSlot, activeSseCount } from "./sse-limit";

describe("sse-limit (per-user concurrent stream cap)", () => {
  it("allows up to the cap, then rejects", () => {
    const u = `u-${Math.random()}`;
    expect(acquireSseSlot(u, 2)).toBe(true);
    expect(acquireSseSlot(u, 2)).toBe(true);
    expect(acquireSseSlot(u, 2)).toBe(false);
    expect(activeSseCount(u)).toBe(2);
  });

  it("frees a slot on release", () => {
    const u = `u-${Math.random()}`;
    expect(acquireSseSlot(u, 1)).toBe(true);
    expect(acquireSseSlot(u, 1)).toBe(false);
    releaseSseSlot(u);
    expect(activeSseCount(u)).toBe(0);
    expect(acquireSseSlot(u, 1)).toBe(true);
  });

  it("isolates users", () => {
    const a = `a-${Math.random()}`;
    const b = `b-${Math.random()}`;
    expect(acquireSseSlot(a, 1)).toBe(true);
    expect(acquireSseSlot(a, 1)).toBe(false);
    expect(acquireSseSlot(b, 1)).toBe(true); // b unaffected
  });

  it("never lets the count go negative on over-release", () => {
    const u = `u-${Math.random()}`;
    releaseSseSlot(u);
    releaseSseSlot(u);
    expect(activeSseCount(u)).toBe(0);
  });
});
