import "dotenv/config";
import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/prisma";
import { generateToken } from "@/lib/api/token";
import { POST } from "./route";
import { PATCH, DELETE } from "./[id]/route";

async function setup() {
  const user = await prisma.user.create({ data: { email: `h-rt-${Date.now()}-${Math.random()}@test.local` } });
  const t = generateToken();
  await prisma.apiToken.create({ data: { userId: user.id, name: "t", tokenHash: t.hash, prefix: t.prefix } });
  const source = await prisma.source.create({ data: { userId: user.id, name: "s", slug: `h-rt-${Date.now()}-${Math.random().toString(36).slice(2)}` } });
  const dest = await prisma.destination.create({ data: { userId: user.id, name: "d", url: "https://example.test/" } });
  return { raw: t.raw, source, dest };
}
function jsonReq(url: string, raw: string, method = "GET", body?: unknown): Request {
  return new Request(url, {
    method,
    headers: { authorization: `Bearer ${raw}`, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const noParams = { params: Promise.resolve({}) };

describe("/api/v1/routes handlers", () => {
  it("creates a route then 409s on duplicate", async () => {
    const { raw, source, dest } = await setup();
    const created = await POST(jsonReq("https://x/api/v1/routes", raw, "POST", { sourceId: source.id, destinationId: dest.id }), noParams);
    expect(created.status).toBe(201);
    const dup = await POST(jsonReq("https://x/api/v1/routes", raw, "POST", { sourceId: source.id, destinationId: dest.id }), noParams);
    expect(dup.status).toBe(409);
  });

  it("404s creating a route to a destination you don't own", async () => {
    const a = await setup();
    const b = await setup();
    const res = await POST(jsonReq("https://x/api/v1/routes", a.raw, "POST", { sourceId: a.source.id, destinationId: b.dest.id }), noParams);
    expect(res.status).toBe(404);
  });

  it("patches enabled and deletes", async () => {
    const { raw, source, dest } = await setup();
    const created = await POST(jsonReq("https://x/api/v1/routes", raw, "POST", { sourceId: source.id, destinationId: dest.id }), noParams);
    const route = await created.json();
    const patched = await PATCH(jsonReq(`https://x/api/v1/routes/${route.id}`, raw, "PATCH", { enabled: false }), params(route.id));
    expect((await patched.json()).enabled).toBe(false);
    expect((await DELETE(jsonReq(`https://x/api/v1/routes/${route.id}`, raw, "DELETE"), params(route.id))).status).toBe(204);
  });
});
