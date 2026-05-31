import "dotenv/config";
import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/prisma";
import { generateToken } from "@/lib/api/token";
import { GET } from "./route";

async function makeUserWithToken() {
  const user = await prisma.user.create({
    data: { email: `h-listen-${Date.now()}-${Math.random()}@test.local` },
  });
  const t = generateToken();
  await prisma.apiToken.create({
    data: { userId: user.id, name: "t", tokenHash: t.hash, prefix: t.prefix },
  });
  return { user, raw: t.raw };
}

function req(url: string, raw: string | null): Request {
  return new Request(url, {
    headers: raw ? { authorization: `Bearer ${raw}` } : {},
  });
}
const ctx = { params: Promise.resolve({}) };

describe("GET /api/v1/listen", () => {
  it("401s without a token", async () => {
    const res = await GET(req("https://x/api/v1/listen?source=foo", null), ctx);
    expect(res.status).toBe(401);
  });

  it("404s for an unknown source slug", async () => {
    const { raw } = await makeUserWithToken();
    const res = await GET(req("https://x/api/v1/listen?source=nope-nope", raw), ctx);
    expect(res.status).toBe(404);
  });

  it("404s for another user's source", async () => {
    const a = await makeUserWithToken();
    const b = await makeUserWithToken();
    const src = await prisma.source.create({
      data: { userId: a.user.id, name: "A", slug: `a-${Date.now()}` },
    });
    const res = await GET(req(`https://x/api/v1/listen?source=${src.slug}`, b.raw), ctx);
    expect(res.status).toBe(404);
  });

  it("returns a text/event-stream for an owned source", async () => {
    const a = await makeUserWithToken();
    const src = await prisma.source.create({
      data: { userId: a.user.id, name: "B", slug: `b-${Date.now()}` },
    });
    const res = await GET(req(`https://x/api/v1/listen?source=${src.slug}`, a.raw), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    await res.body?.cancel();
  });
});
