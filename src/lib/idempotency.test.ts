import { describe, it, expect } from "vitest";
import crypto from "node:crypto";

import { computeIdempotencyKey } from "./idempotency";

function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

describe("computeIdempotencyKey — priority order", () => {
  const body = '{"id":"evt_123","amount":100}';

  it("prefers an explicit Idempotency-Key header over everything else", () => {
    const h = new Headers({
      "idempotency-key": "abc-123",
      "x-github-delivery": "gh-456",
    });
    expect(computeIdempotencyKey(h, body, "stripe")).toBe("hdr:abc-123");
  });

  it("trims whitespace from Idempotency-Key", () => {
    const h = new Headers({ "idempotency-key": "  spaced  " });
    expect(computeIdempotencyKey(h, body, null)).toBe("hdr:spaced");
  });

  it("falls back to Stripe `id` when verifyStyle=stripe", () => {
    const h = new Headers();
    expect(computeIdempotencyKey(h, body, "stripe")).toBe("stripe:evt_123");
  });

  it("does NOT honour Stripe id when verifyStyle is not stripe (anti-spoofing)", () => {
    const h = new Headers();
    expect(computeIdempotencyKey(h, body, "generic-sha256")).toBe(
      `body:${sha256Hex(body)}`,
    );
  });

  it("uses X-GitHub-Delivery when verifyStyle=github", () => {
    const h = new Headers({ "x-github-delivery": "deliv-789" });
    expect(computeIdempotencyKey(h, body, "github")).toBe("gh:deliv-789");
  });

  it("does NOT honour X-GitHub-Delivery when verifyStyle is not github", () => {
    const h = new Headers({ "x-github-delivery": "deliv-789" });
    expect(computeIdempotencyKey(h, body, null)).toBe(
      `body:${sha256Hex(body)}`,
    );
  });

  it("falls back to sha256(body) when nothing else is available", () => {
    const h = new Headers();
    expect(computeIdempotencyKey(h, "raw payload", null)).toBe(
      `body:${sha256Hex("raw payload")}`,
    );
  });

  it("produces stable keys for the same body across calls (provider retries)", () => {
    const h1 = new Headers();
    const h2 = new Headers();
    expect(computeIdempotencyKey(h1, body, null)).toBe(
      computeIdempotencyKey(h2, body, null),
    );
  });

  it("falls back when verifyStyle=stripe but the body isn't valid JSON", () => {
    const h = new Headers();
    expect(computeIdempotencyKey(h, "not-json", "stripe")).toBe(
      `body:${sha256Hex("not-json")}`,
    );
  });

  it("falls back when verifyStyle=stripe but the body has no `id` field", () => {
    const noId = '{"amount":100}';
    const h = new Headers();
    expect(computeIdempotencyKey(h, noId, "stripe")).toBe(
      `body:${sha256Hex(noId)}`,
    );
  });

  it("ignores an empty Idempotency-Key (falls through)", () => {
    const h = new Headers({ "idempotency-key": "   " });
    expect(computeIdempotencyKey(h, body, null)).toBe(
      `body:${sha256Hex(body)}`,
    );
  });
});
