import { z } from "zod";

import { prisma } from "@/lib/prisma";
import { generateToken } from "@/lib/api/token";
import { assertWithinQuota } from "@/lib/quota";

const nameSchema = z.string().min(1).max(60);

export type ApiTokenSummary = {
  id: string;
  name: string;
  prefix: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

export async function createTokenForUser(userId: string, name: string) {
  const parsedName = nameSchema.parse(name);
  await assertWithinQuota(userId, "apiTokens");
  const t = generateToken();
  const record = await prisma.apiToken.create({
    data: { userId, name: parsedName, tokenHash: t.hash, prefix: t.prefix },
  });
  return { token: t.raw, record };
}

export async function listTokensForUser(userId: string): Promise<ApiTokenSummary[]> {
  const rows = await prisma.apiToken.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
    revokedAt: r.revokedAt ? r.revokedAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function revokeTokenForUser(userId: string, id: string): Promise<boolean> {
  const res = await prisma.apiToken.updateMany({
    where: { id, userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return res.count > 0;
}
