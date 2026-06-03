import { describe, it, expect } from "vitest";

import {
  readJsonLimited,
  BodyTooLargeError,
  InvalidJsonError,
} from "./body";

function jsonReq(body: string, headers: Record<string, string> = {}): Request {
  return new Request("http://x/", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

// A streaming body with NO Content-Length header, so the size guard must rely
// on the capped read rather than the pre-check. This is the real attack shape:
// an attacker omits or lies about Content-Length and streams more.
function streamReq(chunks: string[]): Request {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Request("http://x/", {
    method: "POST",
    body: stream,
    // Node/undici requires duplex for a stream body; not in the DOM lib types.
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

describe("readJsonLimited", () => {
  it("parses a small valid JSON body", async () => {
    const out = await readJsonLimited(jsonReq(JSON.stringify({ a: 1, b: "x" })));
    expect(out).toEqual({ a: 1, b: "x" });
  });

  it("throws InvalidJsonError on malformed JSON", async () => {
    await expect(readJsonLimited(jsonReq("{not json"))).rejects.toBeInstanceOf(
      InvalidJsonError,
    );
  });

  it("throws InvalidJsonError on an empty/absent body", async () => {
    const req = new Request("http://x/", { method: "POST" });
    await expect(readJsonLimited(req)).rejects.toBeInstanceOf(InvalidJsonError);
  });

  it("rejects via the Content-Length pre-check before reading", async () => {
    // Body of 50 bytes, limit 10 → undici sets content-length=50 → pre-check trips.
    const big = JSON.stringify({ s: "x".repeat(60) });
    await expect(readJsonLimited(jsonReq(big), 10)).rejects.toBeInstanceOf(
      BodyTooLargeError,
    );
  });

  it("rejects an over-cap streaming body that has no Content-Length", async () => {
    // 12 bytes streamed, limit 8, no content-length → only the capped read catches it.
    await expect(
      readJsonLimited(streamReq(["aaaa", "bbbb", "cccc"]), 8),
    ).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it("accepts a body exactly at the limit", async () => {
    const body = JSON.stringify({ a: 1 }); // 9 bytes
    const out = await readJsonLimited(jsonReq(body), body.length);
    expect(out).toEqual({ a: 1 });
  });

  it("honours the default limit (256 KiB) for a normal payload", async () => {
    const out = await readJsonLimited(jsonReq(JSON.stringify({ ok: true })));
    expect(out).toEqual({ ok: true });
  });
});
