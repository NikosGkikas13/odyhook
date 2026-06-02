import "dotenv/config";
import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/prisma";
import { generateToken } from "@/lib/api/token";
import { POST } from "./route";

function uniq(p: string) {
  return `${p}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
function req(body: unknown, raw: string | null): Request {
  return new Request("https://x/api/v1/events/search", {
    method: "POST",
    headers: { "content-type": "application/json", ...(raw ? { authorization: `Bearer ${raw}` } : {}) },
    body: JSON.stringify(body),
  });
}
const noParams = { params: Promise.resolve({}) };

async function userWithToken() {
  const user = await prisma.user.create({ data: { email: `${uniq("apis")}@test.local` } });
  const t = generateToken();
  await prisma.apiToken.create({ data: { userId: user.id, name: "t", tokenHash: t.hash, prefix: t.prefix } });
  return { user, raw: t.raw };
}

describe("POST /api/v1/events/search", () => {
  it("401s without a token", async () => {
    const res = await POST(req({ q: "failed events" }, null), noParams);
    expect(res.status).toBe(401);
  });

  it("400s when the user has no Anthropic key", async () => {
    const { raw } = await userWithToken();
    const res = await POST(req({ q: "failed events" }, raw), noParams);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toMatch(/Anthropic API key/i);
  });

  it("400s on a missing q", async () => {
    const { raw } = await userWithToken();
    const res = await POST(req({}, raw), noParams);
    expect(res.status).toBe(400);
  });
});
