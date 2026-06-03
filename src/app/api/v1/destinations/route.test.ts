import "dotenv/config";
import { describe, it, expect, vi } from "vitest";

// assertSafeUrl does a live DNS lookup which fails for .test TLDs. Swap it for
// parseSafeUrl (sync, IP-only) so example.test URLs work while private-IP
// literals like 169.254.169.254 are still rejected synchronously.
vi.mock("@/lib/ssrf", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/ssrf")>();
  return { ...mod, assertSafeUrl: (url: string) => Promise.resolve(mod.parseSafeUrl(url)) };
});

import { prisma } from "@/lib/prisma";
import { generateToken } from "@/lib/api/token";
import { GET, POST } from "./route";
import { GET as GET_ONE, PATCH, DELETE } from "./[id]/route";

async function makeUserWithToken() {
  const user = await prisma.user.create({ data: { email: `h-dst-${Date.now()}-${Math.random()}@test.local` } });
  const t = generateToken();
  await prisma.apiToken.create({ data: { userId: user.id, name: "t", tokenHash: t.hash, prefix: t.prefix } });
  return { user, raw: t.raw };
}
function jsonReq(url: string, raw: string | null, method = "GET", body?: unknown): Request {
  return new Request(url, {
    method,
    headers: { ...(raw ? { authorization: `Bearer ${raw}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const noParams = { params: Promise.resolve({}) };

describe("/api/v1/destinations handlers", () => {
  it("401s without a token", async () => {
    expect((await GET(jsonReq("https://x/api/v1/destinations", null), noParams)).status).toBe(401);
  });

  it("creates a destination and hides secrets", async () => {
    const { raw } = await makeUserWithToken();
    const res = await POST(
      jsonReq("https://x/api/v1/destinations", raw, "POST", {
        name: "hook", url: "https://example.test/hook", outboundSecret: "supersecretsupersecret",
      }),
      noParams,
    );
    expect(res.status).toBe(201);
    const dto = await res.json();
    expect(dto.hasOutboundSecret).toBe(true);
    expect(dto.outboundSecretEnc).toBeUndefined();
  });

  it("400s on an SSRF-unsafe url", async () => {
    const { raw } = await makeUserWithToken();
    const res = await POST(
      jsonReq("https://x/api/v1/destinations", raw, "POST", { name: "x", url: "http://169.254.169.254/" }),
      noParams,
    );
    expect(res.status).toBe(400);
  });

  it("updates timeout, owner-scoped 404", async () => {
    const a = await makeUserWithToken();
    const b = await makeUserWithToken();
    const created = await POST(jsonReq("https://x/api/v1/destinations", a.raw, "POST", { name: "A", url: "https://example.test/" }), noParams);
    const dto = await created.json();
    const patched = await PATCH(jsonReq(`https://x/api/v1/destinations/${dto.id}`, a.raw, "PATCH", { timeoutMs: 5000 }), params(dto.id));
    expect((await patched.json()).timeoutMs).toBe(5000);
    expect((await GET_ONE(jsonReq(`https://x/api/v1/destinations/${dto.id}`, b.raw), params(dto.id))).status).toBe(404);
    expect((await DELETE(jsonReq(`https://x/api/v1/destinations/${dto.id}`, a.raw, "DELETE"), params(dto.id))).status).toBe(204);
  });

  it("409s when the per-account destination quota is reached", async () => {
    const { raw } = await makeUserWithToken();
    process.env.MAX_DESTINATIONS_PER_USER = "1";
    try {
      const first = await POST(
        jsonReq("https://x/api/v1/destinations", raw, "POST", { name: "one", url: "https://example.test/1" }),
        noParams,
      );
      expect(first.status).toBe(201);
      const second = await POST(
        jsonReq("https://x/api/v1/destinations", raw, "POST", { name: "two", url: "https://example.test/2" }),
        noParams,
      );
      expect(second.status).toBe(409);
    } finally {
      delete process.env.MAX_DESTINATIONS_PER_USER;
    }
  });
});
