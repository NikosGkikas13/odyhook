import crypto from "node:crypto";

const HEX_RE = /^[0-9a-fA-F]*$/;

/**
 * Constant-time comparison of two hex strings of equal length.
 *
 * Validates the hex charset first: a same-length but non-hex input would make
 * `Buffer.from(_, "hex")` truncate at the first bad pair, yielding a shorter
 * buffer and a `RangeError` from `timingSafeEqual` (which the ingest handler
 * mapped to 500). Reject malformed input as a plain mismatch → 401.
 */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  if (!HEX_RE.test(a) || !HEX_RE.test(b)) return false;
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Verify a generic `sha256=<hex>` style signature over the raw body.
 * Used for GitHub-style and generic HMAC webhook sources.
 */
export function verifySha256(
  rawBody: string,
  signatureHeader: string | null | undefined,
  secret: string,
): boolean {
  if (!signatureHeader) return false;
  const received = signatureHeader.startsWith("sha256=")
    ? signatureHeader.slice("sha256=".length)
    : signatureHeader;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("hex");
  return timingSafeEqualHex(received, expected);
}

// Default Stripe tolerance — matches Stripe's own SDK default.
const DEFAULT_STRIPE_TOLERANCE_SEC = 300;

/**
 * Verify a Stripe-style `Stripe-Signature: t=...,v1=...` header.
 *
 * Rejects signatures whose timestamp is more than `toleranceSec` seconds
 * away from now (replay protection). Pass `Infinity` to disable.
 */
export function verifyStripe(
  rawBody: string,
  signatureHeader: string | null | undefined,
  secret: string,
  toleranceSec: number = DEFAULT_STRIPE_TOLERANCE_SEC,
): boolean {
  if (!signatureHeader) return false;
  const parts = signatureHeader.split(",").map((p) => p.trim());
  const ts = parts.find((p) => p.startsWith("t="))?.slice(2);
  const v1 = parts.find((p) => p.startsWith("v1="))?.slice(3);
  if (!ts || !v1) return false;

  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return false;
  if (Number.isFinite(toleranceSec)) {
    const skew = Math.abs(Date.now() / 1000 - tsNum);
    if (skew > toleranceSec) return false;
  }

  const payload = `${ts}.${rawBody}`;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(payload, "utf8")
    .digest("hex");
  return timingSafeEqualHex(v1, expected);
}

export type VerifyStyle = "stripe" | "github" | "generic-sha256";

export function verifySignature(
  style: VerifyStyle,
  rawBody: string,
  headers: Headers,
  secret: string,
): boolean {
  switch (style) {
    case "stripe":
      return verifyStripe(rawBody, headers.get("stripe-signature"), secret);
    case "github":
      return verifySha256(
        rawBody,
        headers.get("x-hub-signature-256"),
        secret,
      );
    case "generic-sha256":
      return verifySha256(
        rawBody,
        headers.get("x-signature-256") ?? headers.get("x-signature"),
        secret,
      );
  }
}
