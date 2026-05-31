import { describe, it, expect } from "vitest";
import { buildTriggerRequest, parseHeaderFlags } from "./trigger";

describe("parseHeaderFlags", () => {
  it("parses repeated K:V header flags", () => {
    expect(parseHeaderFlags(["X-A: 1", "X-B:2"])).toEqual({
      "X-A": "1",
      "X-B": "2",
    });
  });
  it("ignores malformed entries", () => {
    expect(parseHeaderFlags(["nope"])).toEqual({});
  });
});

describe("buildTriggerRequest", () => {
  it("targets the source ingest URL with body + headers", () => {
    const req = buildTriggerRequest(
      { host: "https://odyhook.dev", token: "ody_x" },
      "gh-prod",
      '{"hello":"world"}',
      { "X-Custom": "1" },
    );
    expect(req.url).toBe("https://odyhook.dev/api/ingest/gh-prod");
    expect(req.method).toBe("POST");
    expect(req.body).toBe('{"hello":"world"}');
    expect(req.headers["X-Custom"]).toBe("1");
    expect(req.headers["content-type"]).toBe("application/json");
  });
});
