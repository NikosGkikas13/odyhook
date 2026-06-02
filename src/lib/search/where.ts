import { Prisma } from "@/generated/prisma/client";
import type { EventQuery } from "./types";

/** Build the Prisma WHERE for an event metadata query. Always scopes by owner. */
export function buildEventWhere(
  userId: string,
  md: EventQuery["metadata"],
): Prisma.EventWhereInput {
  const where: Prisma.EventWhereInput = { source: { userId } };
  if (md.sourceId) where.sourceId = md.sourceId;

  const gte = md.receivedAfter ? new Date(md.receivedAfter) : undefined;
  const lt = md.receivedBefore ? new Date(md.receivedBefore) : undefined;
  if (gte || lt) {
    where.receivedAt = { ...(gte ? { gte } : {}), ...(lt ? { lt } : {}) };
  }

  if (md.status && md.status.length > 0) {
    where.deliveries = { some: { status: { in: md.status } } };
  }
  return where;
}
