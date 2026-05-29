import crypto from "node:crypto";

const TOKEN_PREFIX = "ody_";
// "ody_" + 4 chars — enough to recognize a token in the UI without storing it.
const PREFIX_DISPLAY_LEN = 8;

export type GeneratedToken = { raw: string; hash: string; prefix: string };

/** sha256 hex of a raw token. The only form we persist. */
export function hashToken(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

/** Mint a new token. `raw` is shown to the user once and never stored. */
export function generateToken(): GeneratedToken {
  const raw = TOKEN_PREFIX + crypto.randomBytes(32).toString("base64url");
  return { raw, hash: hashToken(raw), prefix: raw.slice(0, PREFIX_DISPLAY_LEN) };
}

/** Extract the credential from an `Authorization: Bearer <x>` header. */
export function parseBearer(header: string | null): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(header);
  return m ? m[1] : null;
}
