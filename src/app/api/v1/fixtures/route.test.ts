import "dotenv/config";
import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/prisma";
import { generateToken } from "@/lib/api/token";
import { POST } from "./route";

async function makeUserWithToken() {
  const user = await prisma.user.create({
    data: { email: `h-fixtures-${Date.now()}-${Math.random()}@test.local` },
  });
  const t = generateToken();
  await prisma.apiToken.create({
    data: { userId: user.id, name: "t", tokenHash: t.hash, prefix: t.prefix },
  });
  return { user, raw: t.raw };
}

function postReq(raw: string | null, body: unknown): Request {
  return new Request("https://x/api/v1/fixtures", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(raw ? { authorization: `Bearer ${raw}` } : {}),
    },
    body: JSON.stringify(body),
  });
}
const ctx = { params: Promise.resolve({}) };

describe("POST /api/v1/fixtures", () => {
  it("401s without a token", async () => {
    const res = await POST(postReq(null, { source: "foo", prompt: "x" }), ctx);
    expect(res.status).toBe(401);
  });

  it("404s for an unknown source slug", async () => {
    const { raw } = await makeUserWithToken();
    const res = await POST(postReq(raw, { source: "nope-nope", prompt: "x" }), ctx);
    expect(res.status).toBe(404);
  });

  it("404s for another user's source", async () => {
    const a = await makeUserWithToken();
    const b = await makeUserWithToken();
    const src = await prisma.source.create({
      data: { userId: a.user.id, name: "A", slug: `fa-${Date.now()}` },
    });
    const res = await POST(postReq(b.raw, { source: src.slug, prompt: "x" }), ctx);
    expect(res.status).toBe(404);
  });

  it("400s when the user has no Anthropic key configured", async () => {
    const a = await makeUserWithToken();
    const src = await prisma.source.create({
      data: { userId: a.user.id, name: "B", slug: `fb-${Date.now()}` },
    });
    const res = await POST(postReq(a.raw, { source: src.slug, prompt: "a test event" }), ctx);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toMatch(/API key/i);
  });
});
