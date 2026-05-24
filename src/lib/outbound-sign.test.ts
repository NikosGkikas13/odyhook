import { describe, it, expect } from "vitest";
import crypto from "node:crypto";

import {
  OUTBOUND_SIGNATURE_HEADER,
  OUTBOUND_TIMESTAMP_HEADER,
  signOutbound,
} from "./outbound-sign";

function expectedHex(secret: string, ts: string, body: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update(`${ts}.${body}`, "utf8")
    .digest("hex");
}

describe("signOutbound", () => {
  const secret = "shared-secret-xyz";
  const body = '{"event":"ping"}';

  it("produces a v1=<hex> signature over `${ts}.${body}`", () => {
    const fixed = new Date("2026-05-24T15:00:00Z");
    const expectedTs = Math.floor(fixed.getTime() / 1000).toString();
    const { signature, timestamp } = signOutbound(secret, body, fixed);
    expect(timestamp).toBe(expectedTs);
    expect(signature).toBe(`v1=${expectedHex(secret, expectedTs, body)}`);
  });

  it("changes the signature when the body changes", () => {
    const fixed = new Date("2026-05-24T15:00:00Z");
    const a = signOutbound(secret, "a", fixed);
    const b = signOutbound(secret, "b", fixed);
    expect(a.signature).not.toBe(b.signature);
    expect(a.timestamp).toBe(b.timestamp);
  });

  it("changes the signature when the secret changes", () => {
    const fixed = new Date("2026-05-24T15:00:00Z");
    const a = signOutbound("s1", body, fixed);
    const b = signOutbound("s2", body, fixed);
    expect(a.signature).not.toBe(b.signature);
  });

  it("emits a unix-second timestamp string", () => {
    const fixed = new Date(1_700_000_000_000);
    const { timestamp } = signOutbound(secret, body, fixed);
    expect(timestamp).toBe("1700000000");
  });

  it("header constants match the documented contract", () => {
    expect(OUTBOUND_SIGNATURE_HEADER).toBe("X-Odyhook-Signature");
    expect(OUTBOUND_TIMESTAMP_HEADER).toBe("X-Odyhook-Timestamp");
  });
});
