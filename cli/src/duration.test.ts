import { describe, it, expect } from "vitest";
import { parseDuration } from "./duration";

describe("parseDuration", () => {
  it("parses seconds, minutes, hours, days", () => {
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("5m")).toBe(300_000);
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(parseDuration("1d")).toBe(86_400_000);
  });
  it("returns null for invalid input", () => {
    expect(parseDuration("")).toBeNull();
    expect(parseDuration("10x")).toBeNull();
    expect(parseDuration("abc")).toBeNull();
  });
});
