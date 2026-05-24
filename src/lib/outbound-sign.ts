import crypto from "node:crypto";

export const OUTBOUND_SIGNATURE_HEADER = "X-Odyhook-Signature";
export const OUTBOUND_TIMESTAMP_HEADER = "X-Odyhook-Timestamp";

/**
 * Produce an outbound HMAC signature over `${unix_ts}.${body}` using SHA-256.
 *
 * Receivers verify with:
 *   const expected = hmacSha256(secret, `${X-Odyhook-Timestamp}.${rawBody}`);
 *   const sig = req.headers["x-odyhook-signature"].replace(/^v1=/, "");
 *   timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"));
 *
 * The timestamp is included in the signed payload so receivers can reject
 * replays (same shape as Stripe's scheme).
 */
export function signOutbound(
  secret: string,
  body: string,
  now: Date = new Date(),
): { signature: string; timestamp: string } {
  const timestamp = Math.floor(now.getTime() / 1000).toString();
  const payload = `${timestamp}.${body}`;
  const hex = crypto
    .createHmac("sha256", secret)
    .update(payload, "utf8")
    .digest("hex");
  return { signature: `v1=${hex}`, timestamp };
}
