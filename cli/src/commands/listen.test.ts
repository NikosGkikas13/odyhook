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
