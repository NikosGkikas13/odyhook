import { describe, it, expect } from "vitest";
import { extractJsonText } from "./json";

describe("extractJsonText", () => {
  it("returns bare JSON unchanged (trimmed)", () => {
    expect(extractJsonText('  {"a":1}  ')).toBe('{"a":1}');
  });

  it("strips a ```json fence", () => {
    expect(extractJsonText('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("strips a bare ``` fence", () => {
    expect(extractJsonText('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("leaves non-JSON text for the caller's JSON.parse to reject", () => {
    expect(extractJsonText("not json at all")).toBe("not json at all");
  });

  it("strips a fence with CRLF line endings", () => {
    expect(extractJsonText('```json\r\n{"a":1}\r\n```')).toBe('{"a":1}');
  });

  it("strips a closing fence with no preceding newline", () => {
    expect(extractJsonText('```json\n{"a":1}```')).toBe('{"a":1}');
  });
});
