import { describe, it, expect } from "vitest";
import { buildTriggerRequest, parseHeaderFlags, resolveTriggerMode, buildGenerateRequest, generateAndSend } from "./trigger";
import type { Config } from "../config";

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

describe("resolveTriggerMode", () => {
  it("returns the single chosen mode", () => {
    expect(resolveTriggerMode({ data: "@f.json" })).toEqual({ mode: "data" });
    expect(resolveTriggerMode({ replay: "evt_1" })).toEqual({ mode: "replay" });
    expect(resolveTriggerMode({ generate: "a test" })).toEqual({ mode: "generate" });
  });
  it("errors when none are provided", () => {
    expect(resolveTriggerMode({})).toEqual({
      error: "Provide one of --data, --replay, or --generate.",
    });
  });
  it("errors when more than one is provided", () => {
    const r = resolveTriggerMode({ data: "@f.json", generate: "x" });
    expect("error" in r && r.error).toMatch(/mutually exclusive/i);
  });
});

describe("buildGenerateRequest", () => {
  it("targets /api/v1/fixtures with bearer auth and {source,prompt}", () => {
    const cfg: Config = { host: "https://odyhook.dev", token: "ody_x" };
    const req = buildGenerateRequest(cfg, "gh-prod", "a push event");
    expect(req.url).toBe("https://odyhook.dev/api/v1/fixtures");
    expect(req.headers.authorization).toBe("Bearer ody_x");
    expect(req.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(req.body)).toEqual({ source: "gh-prod", prompt: "a push event" });
  });
});

describe("generateAndSend", () => {
  const cfg: Config = { host: "https://odyhook.dev", token: "ody_x" };

  it("generates then POSTs the fixture to ingest", async () => {
    const calls: string[] = [];
    const fakeFetch = (async (url: string) => {
      calls.push(url);
      if (url.includes("/api/v1/fixtures")) {
        return new Response(
          JSON.stringify({ body: '{"hello":"world"}', model: "m", groundedOn: 0 }),
          { status: 200 },
        );
      }
      return new Response("accepted", { status: 202 });
    }) as unknown as typeof fetch;

    await generateAndSend(cfg, "gh-prod", "a test event", { dryRun: false, headers: {} }, fakeFetch);

    expect(calls).toEqual([
      "https://odyhook.dev/api/v1/fixtures",
      "https://odyhook.dev/api/ingest/gh-prod",
    ]);
  });

  it("with dryRun, generates but does NOT POST to ingest", async () => {
    const calls: string[] = [];
    const fakeFetch = (async (url: string) => {
      calls.push(url);
      return new Response(
        JSON.stringify({ body: '{"hello":"world"}', model: "m", groundedOn: 0 }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    await generateAndSend(cfg, "gh-prod", "a test event", { dryRun: true, headers: {} }, fakeFetch);

    expect(calls).toEqual(["https://odyhook.dev/api/v1/fixtures"]);
  });
});
