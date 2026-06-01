import { prisma } from "@/lib/prisma";
import { toDate } from "@/lib/dates";
import { Prisma } from "@/generated/prisma/client";
import type { DeliveryStatus } from "@/generated/prisma/enums";
import type { Page } from "@/lib/api/respond";

export type DeliveryListItem = {
  id: string;
  eventId: string;
  sourceId: string;
  destinationId: string;
  status: DeliveryStatus;
  attemptCount: number;
  responseCode: number | null;
  lastError: string | null;
  createdAt: string;
  deliveredAt: string | null;
};

export type DeliveryFilter = {
  sourceId?: string;
  destinationId?: string;
  status?: DeliveryStatus[];
  since?: string;
  until?: string;
};

export async function listDeliveries(
  userId: string,
  filter: DeliveryFilter,
  page: Page,
): Promise<{ data: DeliveryListItem[]; nextCursor: string | null }> {
  const where: Prisma.DeliveryWhereInput = {
    event: {
      source: { userId },
      ...(filter.sourceId ? { sourceId: filter.sourceId } : {}),
    },
    ...(filter.destinationId ? { destinationId: filter.destinationId } : {}),
    ...(filter.status && filter.status.length
      ? { status: { in: filter.status } }
      : {}),
    ...(filter.since || filter.until
      ? {
          createdAt: {
            ...(filter.since ? { gte: toDate("since", filter.since) } : {}),
            ...(filter.until ? { lte: toDate("until", filter.until) } : {}),
          },
        }
      : {}),
  };

  const rows = await prisma.delivery.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: page.limit,
    ...(page.cursor ? { cursor: { id: page.cursor }, skip: 1 } : {}),
    include: { event: { select: { sourceId: true } } },
  });

  const nextCursor = rows.length === page.limit ? rows[rows.length - 1].id : null;
  return {
    data: rows.map((d) => ({
      id: d.id,
      eventId: d.eventId,
      sourceId: d.event.sourceId,
      destinationId: d.destinationId,
      status: d.status,
      attemptCount: d.attemptCount,
      responseCode: d.responseCode,
      lastError: d.lastError,
      createdAt: d.createdAt.toISOString(),
      deliveredAt: d.deliveredAt ? d.deliveredAt.toISOString() : null,
    })),
    nextCursor,
  };
}
