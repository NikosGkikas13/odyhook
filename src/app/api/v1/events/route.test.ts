import "dotenv/config";
import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/prisma";
import { generateToken } from "@/lib/api/token";
import { GET } from "./route";
import { GET as GET_ONE } from "./[id]/route";

async function setup() {
  const user = await prisma.user.create({ data: { email: `h-ev-${Date.now()}-${Math.random()}@test.local` } });
  const t = generateToken();
  await prisma.apiToken.create({ data: { userId: user.id, name: "t", tokenHash: t.hash, prefix: t.prefix } });
  const source = await prisma.source.create({ data: { userId: user.id, name: "s", slug: `h-ev-${Date.now()}-${Math.random().toString(36).slice(2)}` } });
  const event = await prisma.event.create({ data: { sourceId: source.id, method: "POST", headersJson: {}, bodyRaw: "{}" } });
  return { raw: t.raw, event };
}
function req(url: string, raw: string | null): Request {
  return new Request(url, { headers: raw ? { authorization: `Bearer ${raw}` } : {} });
}
const noParams = { params: Promise.resolve({}) };

describe("/api/v1/events handlers", () => {
  it("401s without a token", async () => {
    expect((await GET(req("https://x/api/v1/events", null), noParams)).status).toBe(401);
  });

  it("lists and gets an event with deliveries", async () => {
    const { raw, event } = await setup();
    const list = await GET(req("https://x/api/v1/events?limit=10", raw), noParams);
    expect(list.status).toBe(200);
    const got = await GET_ONE(req(`https://x/api/v1/events/${event.id}`, raw), { params: Promise.resolve({ id: event.id }) });
    const body = await got.json();
    expect(body.id).toBe(event.id);
    expect(Array.isArray(body.deliveries)).toBe(true);
  });

  it("404s on another user's event", async () => {
    const a = await setup();
    const b = await setup();
    const res = await GET_ONE(req(`https://x/api/v1/events/${a.event.id}`, b.raw), { params: Promise.resolve({ id: a.event.id }) });
    expect(res.status).toBe(404);
  });
});
