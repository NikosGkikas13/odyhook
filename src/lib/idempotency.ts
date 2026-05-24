import crypto from "node:crypto";

/**
 * Derive a stable per-source dedupe key for an incoming webhook.
 *
 * Priority order (first non-empty wins):
 *   1. `Idempotency-Key` header — explicit caller-supplied key.
 *   2. Stripe `id` field parsed from the JSON body when verifyStyle="stripe".
 *      Stripe's own retries replay the same event with the same id.
 *   3. `X-GitHub-Delivery` header when verifyStyle="github".
 *   4. Fallback: `sha256(body)` hex. Catches generic providers that retry
 *      the same payload without any identifier — at the cost of collapsing
 *      identical payloads sent on purpose.
 *
 * The verifyStyle gating on (2) and (3) is intentional: we trust those
 * fields only when the source is configured as that provider. A non-Stripe
 * sender could otherwise spoof a Stripe `id` to deliberately collide with
 * a future legitimate event.
 */
export function computeIdempotencyKey(
  headers: Headers,
  body: string,
  verifyStyle: string | null | undefined,
): string {
  const explicit = headers.get("idempotency-key");
  if (explicit && explicit.trim()) return `hdr:${explicit.trim()}`;

  if (verifyStyle === "stripe") {
    const stripeId = tryParseStripeId(body);
    if (stripeId) return `stripe:${stripeId}`;
  }

  if (verifyStyle === "github") {
    const gh = headers.get("x-github-delivery");
    if (gh && gh.trim()) return `gh:${gh.trim()}`;
  }

  const bodyHash = crypto.createHash("sha256").update(body, "utf8").digest("hex");
  return `body:${bodyHash}`;
}

function tryParseStripeId(body: string): string | null {
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === "object" && typeof parsed.id === "string") {
      return parsed.id;
    }
  } catch {
    // not JSON — fall through
  }
  return null;
}
