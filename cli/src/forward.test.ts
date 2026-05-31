import { describe, it, expect } from "vitest";
import { filterHeaders, forwardEvent, type EventPayload } from "./forward";

const evt: EventPayload = {
  id: "evt_1",
  method: "POST",
  headersJson: {
    "content-type": "application/json",
    host: "odyhook.dev",
    "content-length": "9",
    "x-github-event": "push",
  },
  bodyRaw: '{"ok":true}',
  receivedAt: "2026-05-31T00:00:00.000Z",
};

describe("filterHeaders", () => {
  it("drops hop-by-hop headers but keeps provider headers", () => {
    const out = filterHeaders(evt.headersJson);
    expect(out["x-github-event"]).toBe("push");
    expect(out["content-type"]).toBe("application/json");
    expect(out.host).toBeUndefined();
    expect(out["content-length"]).toBeUndefined();
  });
});

describe("forwardEvent", () => {
  it("POSTs the raw body with filtered headers and reports status", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      captured = { url, init };
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    const res = await forwardEvent(evt, "http://localhost:3000/webhook", fakeFetch);

    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(captured!.url).toBe("http://localhost:3000/webhook");
    expect(captured!.init.method).toBe("POST");
    expect(captured!.init.body).toBe('{"ok":true}');
    const h = captured!.init.headers as Record<string, string>;
    expect(h["x-github-event"]).toBe("push");
    expect(h.host).toBeUndefined();
  });

  it("returns ok=false with an error message when the local target is down", async () => {
    const fakeFetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const res = await forwardEvent(evt, "http://localhost:3000/webhook", fakeFetch);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("ECONNREFUSED");
  });
});
