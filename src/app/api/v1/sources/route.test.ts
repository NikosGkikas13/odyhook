import "dotenv/config";
import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/prisma";
import { generateToken } from "@/lib/api/token";
import { GET, POST } from "./route";
import { GET as GET_ONE, PATCH, DELETE } from "./[id]/route";

async function makeUserWithToken() {
  const user = await prisma.user.create({ data: { email: `h-src-${Date.now()}-${Math.random()}@test.local` } });
  const t = generateToken();
  await prisma.apiToken.create({ data: { userId: user.id, name: "t", tokenHash: t.hash, prefix: t.prefix } });
  return { user, raw: t.raw };
}

function jsonReq(url: string, raw: string | null, method = "GET", body?: unknown): Request {
  return new Request(url, {
    method,
    headers: {
      ...(raw ? { authorization: `Bearer ${raw}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe("/api/v1/sources handlers", () => {
  it("401s without a token", async () => {
    const res = await GET(jsonReq("https://x/api/v1/sources", null), { params: Promise.resolve({}) });
    expect(res.status).toBe(401);
  });

  it("creates, gets, lists, updates, deletes", async () => {
    const { raw } = await makeUserWithToken();
    const created = await POST(
      jsonReq("https://x/api/v1/sources", raw, "POST", { name: "Stripe", verifyStyle: "none" }),
      { params: Promise.resolve({}) },
    );
    expect(created.status).toBe(201);
    const src = await created.json();
    expect(src.hasSigningSecret).toBe(false);

    const got = await GET_ONE(jsonReq(`https://x/api/v1/sources/${src.id}`, raw), params(src.id));
    expect(got.status).toBe(200);

    const list = await GET(jsonReq("https://x/api/v1/sources?limit=5", raw), { params: Promise.resolve({}) });
    expect((await list.json()).data.some((s: { id: string }) => s.id === src.id)).toBe(true);

    const patched = await PATCH(jsonReq(`https://x/api/v1/sources/${src.id}`, raw, "PATCH", { name: "Renamed" }), params(src.id));
    expect((await patched.json()).name).toBe("Renamed");

    const del = await DELETE(jsonReq(`https://x/api/v1/sources/${src.id}`, raw, "DELETE"), params(src.id));
    expect(del.status).toBe(204);
  });

  it("404s on another user's source", async () => {
    const a = await makeUserWithToken();
    const b = await makeUserWithToken();
    const created = await POST(jsonReq("https://x/api/v1/sources", a.raw, "POST", { name: "A", verifyStyle: "none" }), { params: Promise.resolve({}) });
    const src = await created.json();
    const res = await GET_ONE(jsonReq(`https://x/api/v1/sources/${src.id}`, b.raw), params(src.id));
    expect(res.status).toBe(404);
  });

  it("400s on invalid body", async () => {
    const { raw } = await makeUserWithToken();
    const res = await POST(jsonReq("https://x/api/v1/sources", raw, "POST", { name: "" }), { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
  });
});
