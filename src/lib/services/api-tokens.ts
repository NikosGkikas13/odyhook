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
  expiresAt: string | null;
  createdAt: string;
};

/**
 * Mint a token for the user. Pass `expiresInDays` to give it a hard expiry
 * (enforced in authenticateApiToken); omit for a non-expiring token.
 */
export async function createTokenForUser(
  userId: string,
  name: string,
  opts: { expiresInDays?: number } = {},
) {
  const parsedName = nameSchema.parse(name);
  await assertWithinQuota(userId, "apiTokens");
  const t = generateToken();
  const expiresAt =
    opts.expiresInDays && opts.expiresInDays > 0
      ? new Date(Date.now() + opts.expiresInDays * 86_400_000)
      : null;
  const record = await prisma.apiToken.create({
    data: { userId, name: parsedName, tokenHash: t.hash, prefix: t.prefix, expiresAt },
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
    expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
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
