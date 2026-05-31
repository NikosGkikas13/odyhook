import { describe, it, expect } from "vitest";
import { consumeStream } from "./listen";
import type { EventPayload } from "../forward";

function streamFrom(text: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      c.enqueue(enc.encode(text));
      c.close();
    },
  });
}

describe("consumeStream", () => {
  it("forwards each SSE event and returns the last id", async () => {
    const evt: EventPayload = {
      id: "evt_1",
      method: "POST",
      headersJson: { "content-type": "application/json" },
      bodyRaw: '{"n":1}',
      receivedAt: "2026-05-31T00:00:00.000Z",
    };
    const frame = `id: ${evt.id}\ndata: ${JSON.stringify(evt)}\n\n`;

    const forwarded: EventPayload[] = [];
    const lastId = await consumeStream(streamFrom(frame), async (e) => {
      forwarded.push(e);
      return { ok: true, status: 200, ms: 1 };
    });

    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].bodyRaw).toBe('{"n":1}');
    expect(lastId).toBe("evt_1");
  });
});

import { backfillSince } from "./listen";
import type { Config } from "../config";

describe("backfillSince", () => {
  it("forwards only this source's events newer than the cutoff, oldest-first", async () => {
    const cfg: Config = { host: "https://odyhook.dev", token: "ody_abc" };
    const now = Date.now();
    const page = {
      data: [
        { id: "e3", sourceId: "src_1", method: "POST", receivedAt: new Date(now - 1000).toISOString() },
        { id: "e2", sourceId: "src_other", method: "POST", receivedAt: new Date(now - 2000).toISOString() },
        { id: "e1", sourceId: "src_1", method: "POST", receivedAt: new Date(now - 99_000_000).toISOString() },
      ],
      nextCursor: null,
    };
    const detail: Record<string, EventPayload> = {
      e3: { id: "e3", method: "POST", headersJson: {}, bodyRaw: "3", receivedAt: page.data[0].receivedAt },
    };
    const fakeFetch = (async (url: string) => {
      if (url.includes("/api/v1/events/")) {
        const id = url.split("/api/v1/events/")[1];
        return new Response(JSON.stringify(detail[id]), { status: 200 });
      }
      return new Response(JSON.stringify(page), { status: 200 });
    }) as unknown as typeof fetch;

    const forwarded: string[] = [];
    await backfillSince(cfg, "src_1", 60_000, async (e) => {
      forwarded.push(e.id);
      return { ok: true, status: 200, ms: 1 };
    }, fakeFetch);

    // e2 is another source; e1 is older than the 60s cutoff. Only e3 forwards.
    expect(forwarded).toEqual(["e3"]);
  });
});
