import { describe, it, expect } from "vitest";
import { SSEParser } from "./sse";

describe("SSEParser", () => {
  it("parses a single complete event split across chunks", () => {
    const p = new SSEParser();
    expect(p.push("id: evt_1\nda")).toEqual([]);
    const out = p.push('ta: {"a":1}\n\n');
    expect(out).toEqual([{ id: "evt_1", data: '{"a":1}' }]);
  });

  it("parses multiple events in one chunk", () => {
    const p = new SSEParser();
    const out = p.push("id: a\ndata: 1\n\nid: b\ndata: 2\n\n");
    expect(out).toEqual([
      { id: "a", data: "1" },
      { id: "b", data: "2" },
    ]);
  });

  it("ignores comment (heartbeat) lines", () => {
    const p = new SSEParser();
    expect(p.push(": ping\n\n")).toEqual([]);
  });

  it("concatenates multiple data: lines with newlines", () => {
    const p = new SSEParser();
    const out = p.push("data: line1\ndata: line2\n\n");
    expect(out).toEqual([{ id: undefined, data: "line1\nline2" }]);
  });
});
