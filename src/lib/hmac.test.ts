import { describe, it, expect } from "vitest";
import crypto from "node:crypto";

import { verifySha256, verifyStripe, verifySignature } from "./hmac";

function sha256Hex(secret: string, body: string): string {
  return crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

function signStripe(secret: string, body: string, ts: number): string {
  const payload = `${ts}.${body}`;
  const v1 = sha256Hex(secret, payload);
  return `t=${ts},v1=${v1}`;
}

describe("verifySha256", () => {
  const secret = "whsec_test_abc";
  const body = '{"hello":"world"}';
  const sig = sha256Hex(secret, body);

  it("accepts a valid bare hex signature", () => {
    expect(verifySha256(body, sig, secret)).toBe(true);
  });

  it("accepts a valid `sha256=<hex>` prefixed signature (GitHub style)", () => {
    expect(verifySha256(body, `sha256=${sig}`, secret)).toBe(true);
  });

  it("rejects a signature computed with the wrong secret", () => {
    const wrong = sha256Hex("other_secret", body);
    expect(verifySha256(body, wrong, secret)).toBe(false);
  });

  it("rejects a signature for a modified body", () => {
    expect(verifySha256(body + " ", sig, secret)).toBe(false);
  });

  it("rejects a truncated signature", () => {
    expect(verifySha256(body, sig.slice(0, -2), secret)).toBe(false);
  });

  it("rejects a same-length but non-hex signature without throwing (→401 not 500)", () => {
    const nonHex = "z".repeat(sig.length);
    expect(() => verifySha256(body, nonHex, secret)).not.toThrow();
    expect(verifySha256(body, nonHex, secret)).toBe(false);
  });

  it("rejects a null/undefined/empty header", () => {
    expect(verifySha256(body, null, secret)).toBe(false);
    expect(verifySha256(body, undefined, secret)).toBe(false);
    expect(verifySha256(body, "", secret)).toBe(false);
  });
});

describe("verifyStripe", () => {
  const secret = "whsec_stripe_xyz";
  const body = '{"id":"evt_123","type":"charge.succeeded"}';
  const ts = Math.floor(Date.now() / 1000);
  const header = signStripe(secret, body, ts);

  it("accepts a valid Stripe-Signature header", () => {
    expect(verifyStripe(body, header, secret)).toBe(true);
  });

  it("tolerates whitespace around the comma-separated parts", () => {
    const v1 = sha256Hex(secret, `${ts}.${body}`);
    expect(verifyStripe(body, `t=${ts} , v1=${v1}`, secret)).toBe(true);
  });

  it("rejects a header with the wrong secret", () => {
    expect(verifyStripe(body, signStripe("other", body, ts), secret)).toBe(
      false,
    );
  });

  it("rejects if the body was modified", () => {
    expect(verifyStripe(body + "x", header, secret)).toBe(false);
  });

  it("rejects if the timestamp was tampered (breaks v1 hash)", () => {
    const tampered = header.replace(`t=${ts}`, `t=${ts + 1}`);
    expect(verifyStripe(body, tampered, secret)).toBe(false);
  });

  it("rejects if v1 is missing", () => {
    expect(verifyStripe(body, `t=${ts}`, secret)).toBe(false);
  });

  it("rejects if t is missing", () => {
    expect(verifyStripe(body, `v1=deadbeef`, secret)).toBe(false);
  });

  it("rejects null/undefined headers", () => {
    expect(verifyStripe(body, null, secret)).toBe(false);
    expect(verifyStripe(body, undefined, secret)).toBe(false);
  });

  it("rejects timestamps outside the default 5-minute tolerance (replay)", () => {
    const stale = Math.floor(Date.now() / 1000) - 10 * 60; // 10 min ago
    const staleSig = signStripe(secret, body, stale);
    expect(verifyStripe(body, staleSig, secret)).toBe(false);
  });

  it("accepts stale signatures when tolerance is set to Infinity", () => {
    const stale = Math.floor(Date.now() / 1000) - 10 * 60;
    const staleSig = signStripe(secret, body, stale);
    expect(verifyStripe(body, staleSig, secret, Infinity)).toBe(true);
  });

  it("rejects a non-numeric timestamp", () => {
    const v1 = sha256Hex(secret, `notanumber.${body}`);
    expect(verifyStripe(body, `t=notanumber,v1=${v1}`, secret)).toBe(false);
  });

  it("rejects a non-hex v1 without throwing (→401 not 500)", () => {
    const badV1 = "g".repeat(64);
    expect(() => verifyStripe(body, `t=${ts},v1=${badV1}`, secret)).not.toThrow();
    expect(verifyStripe(body, `t=${ts},v1=${badV1}`, secret)).toBe(false);
  });
});

describe("verifySignature dispatch", () => {
  const secret = "s";
  const body = "hello";
  const githubSig = `sha256=${sha256Hex(secret, body)}`;
  const ts = Math.floor(Date.now() / 1000);
  const stripeSig = signStripe(secret, body, ts);

  it("routes github style to x-hub-signature-256", () => {
    const h = new Headers({ "x-hub-signature-256": githubSig });
    expect(verifySignature("github", body, h, secret)).toBe(true);
  });

  it("routes stripe style to stripe-signature", () => {
    const h = new Headers({ "stripe-signature": stripeSig });
    expect(verifySignature("stripe", body, h, secret)).toBe(true);
  });

  it("routes generic-sha256 to x-signature-256", () => {
    const h = new Headers({ "x-signature-256": githubSig });
    expect(verifySignature("generic-sha256", body, h, secret)).toBe(true);
  });

  it("routes generic-sha256 to x-signature as fallback", () => {
    const h = new Headers({ "x-signature": githubSig });
    expect(verifySignature("generic-sha256", body, h, secret)).toBe(true);
  });

  it("returns false when the expected header is missing", () => {
    const h = new Headers({});
    expect(verifySignature("github", body, h, secret)).toBe(false);
    expect(verifySignature("stripe", body, h, secret)).toBe(false);
    expect(verifySignature("generic-sha256", body, h, secret)).toBe(false);
  });
});
