import "dotenv/config";
import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/prisma";
import { generateToken } from "./token";
import { authenticateApiToken } from "./authenticate";

async function makeUser() {
  return prisma.user.create({ data: { email: `auth-${Date.now()}-${Math.random()}@test.local` } });
}

function req(authHeader?: string): Request {
  return new Request("https://x/api/v1/sources", {
    headers: authHeader ? { authorization: authHeader } : {},
  });
}

describe("authenticateApiToken", () => {
  it("returns userId for a valid token", async () => {
    const u = await makeUser();
    const t = generateToken();
    await prisma.apiToken.create({ data: { userId: u.id, name: "t", tokenHash: t.hash, prefix: t.prefix } });
    const res = await authenticateApiToken(req(`Bearer ${t.raw}`));
    expect(res?.userId).toBe(u.id);
  });

  it("returns null for missing, malformed, unknown, and revoked tokens", async () => {
    expect(await authenticateApiToken(req())).toBeNull();
    expect(await authenticateApiToken(req("Bearer notody"))).toBeNull();
    expect(await authenticateApiToken(req("Bearer ody_unknown"))).toBeNull();

    const u = await makeUser();
    const t = generateToken();
    await prisma.apiToken.create({
      data: { userId: u.id, name: "t", tokenHash: t.hash, prefix: t.prefix, revokedAt: new Date() },
    });
    expect(await authenticateApiToken(req(`Bearer ${t.raw}`))).toBeNull();
  });
});
