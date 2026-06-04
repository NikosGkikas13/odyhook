import "dotenv/config";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Session-authed bulk route; stub auth() so the early-return paths
// (401/400/413) run without a DB. None of them reach prisma.
const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));
vi.mock("@/auth", () => ({ auth: authMock }));

import { POST } from "./route";

function req(body: string, origin = "http://x"): Request {
  return new Request("http://x/api/events/bulk-cancel", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body,
  });
}

beforeEach(() => {
  authMock.mockReset();
  authMock.mockResolvedValue({ user: { id: "u1" } });
});

describe("POST /api/events/bulk-cancel body limit", () => {
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

  it("403s on a cross-site Origin (CSRF)", async () => {
    const res = await POST(req(JSON.stringify({ ids: ["a"] }), "http://evil.example"));
    expect(res.status).toBe(403);
  });
});
