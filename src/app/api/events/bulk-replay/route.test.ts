import "dotenv/config";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Bulk routes authenticate via the NextAuth session, not an API token. Stub
// auth() so we can exercise the early-return paths (401/400/413) without a DB
// or Redis — none of those paths reach prisma or the rate limiter.
const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));
vi.mock("@/auth", () => ({ auth: authMock }));

import { POST } from "./route";

function req(body: string): Request {
  return new Request("http://x/api/events/bulk-replay", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

beforeEach(() => {
  authMock.mockReset();
  authMock.mockResolvedValue({ user: { id: "u1" } });
});

describe("POST /api/events/bulk-replay body limit", () => {
  it("401s without a session", async () => {
    authMock.mockResolvedValue(null);
    expect((await POST(req(JSON.stringify({ ids: ["a"] })))).status).toBe(401);
  });

  it("413s on an oversize body", async () => {
    const big = JSON.stringify({ ids: ["x".repeat(300 * 1024)] });
    expect((await POST(req(big))).status).toBe(413);
  });

  it("400s on invalid JSON", async () => {
    expect((await POST(req("{bad"))).status).toBe(400);
  });
});
