import "dotenv/config";
import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/prisma";
import { hashToken } from "@/lib/api/token";
import { createTokenForUser, listTokensForUser, revokeTokenForUser } from "../services/api-tokens";

async function makeUser() {
  return prisma.user.create({ data: { email: `tok-${Date.now()}-${Math.random()}@test.local` } });
}

describe("api-token management", () => {
  it("creates a token, returns raw once, stores only the hash", async () => {
    const u = await makeUser();
    const { token, record } = await createTokenForUser(u.id, "laptop");
    expect(token.startsWith("ody_")).toBe(true);
    const row = await prisma.apiToken.findUnique({ where: { id: record.id } });
    expect(row?.tokenHash).toBe(hashToken(token));
    expect(row?.prefix).toBe(token.slice(0, 8));
  });

  it("lists without exposing the hash", async () => {
    const u = await makeUser();
    await createTokenForUser(u.id, "a");
    const list = await listTokensForUser(u.id);
    expect(list.length).toBe(1);
    expect((list[0] as Record<string, unknown>).tokenHash).toBeUndefined();
    expect(list[0].name).toBe("a");
  });

  it("revoke is owner-scoped and sets revokedAt", async () => {
    const a = await makeUser();
    const b = await makeUser();
    const { record } = await createTokenForUser(a.id, "a");
    expect(await revokeTokenForUser(b.id, record.id)).toBe(false);
    expect(await revokeTokenForUser(a.id, record.id)).toBe(true);
    const row = await prisma.apiToken.findUnique({ where: { id: record.id } });
    expect(row?.revokedAt).not.toBeNull();
  });
});
