import { prisma } from "@/lib/prisma";
import { hashToken, parseBearer } from "./token";

export type ApiAuth = { userId: string; tokenId: string };

/**
 * Resolve an `Authorization: Bearer ody_…` header to its owner. Returns null
 * for missing/malformed/unknown/revoked tokens — callers respond 401.
 */
export async function authenticateApiToken(req: Request): Promise<ApiAuth | null> {
  const raw = parseBearer(req.headers.get("authorization"));
  if (!raw || !raw.startsWith("ody_")) return null;

  const token = await prisma.apiToken.findUnique({ where: { tokenHash: hashToken(raw) } });
  if (!token || token.revokedAt) return null;

  // Fire-and-forget last-used bump; never block or fail the request on it.
  prisma.apiToken
    .update({ where: { id: token.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {});

  return { userId: token.userId, tokenId: token.id };
}
