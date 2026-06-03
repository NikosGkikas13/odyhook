import "dotenv/config";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";

// withApiAuth authenticates + rate-limits before running the handler; stub both
// so we can test its body-reading and error-mapping without a DB or Redis.
const { authMock, rlMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  rlMock: vi.fn(),
}));
vi.mock("./authenticate", () => ({ authenticateApiToken: authMock }));
vi.mock("@/lib/ratelimit", () => ({ checkApiRateLimit: rlMock }));

import { withApiAuth, readJson } from "./handler";
import { BodyTooLargeError } from "./body";

function req(body?: string, headers: Record<string, string> = {}): Request {
  return new Request("http://x/api/v1/thing", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    ...(body !== undefined ? { body } : {}),
  });
}
const ctx = { params: Promise.resolve({}) };

describe("readJson", () => {
  it("parses a small valid body", async () => {
    expect(await readJson(req(JSON.stringify({ a: 1 })))).toEqual({ a: 1 });
  });

  it("throws ZodError on invalid JSON (preserves the 400 mapping)", async () => {
    await expect(readJson(req("{bad"))).rejects.toBeInstanceOf(z.ZodError);
  });

  it("throws BodyTooLargeError when the body exceeds the cap", async () => {
    const big = JSON.stringify({ s: "x".repeat(300 * 1024) });
    await expect(readJson(req(big))).rejects.toBeInstanceOf(BodyTooLargeError);
  });
});

describe("withApiAuth error mapping", () => {
  beforeEach(() => {
    authMock.mockReset();
    rlMock.mockReset();
    authMock.mockResolvedValue({ userId: "u1", tokenId: "t1" });
    rlMock.mockResolvedValue({ allowed: true, retryAfterMs: 0 });
  });

  it("maps a handler-thrown BodyTooLargeError to 413 payload_too_large", async () => {
    const h = withApiAuth(async () => {
      throw new BodyTooLargeError(256 * 1024);
    });
    const res = await h(req(JSON.stringify({})), ctx);
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error.code).toBe("payload_too_large");
  });

  it("still maps ZodError to 400", async () => {
    const h = withApiAuth(async () => {
      throw new z.ZodError([]);
    });
    expect((await h(req(JSON.stringify({})), ctx)).status).toBe(400);
  });

  it("401s when authentication fails", async () => {
    authMock.mockResolvedValue(null);
    const h = withApiAuth(async () => new Response("ok"));
    expect((await h(req(), ctx)).status).toBe(401);
  });
});
