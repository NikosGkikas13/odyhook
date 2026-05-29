import { prisma } from "@/lib/prisma";
import type { Page } from "@/lib/api/respond";

export type EventDTO = {
  id: string;
  sourceId: string;
  method: string;
  receivedAt: string;
  remoteIp: string | null;
  idempotencyKey: string | null;
};

export type DeliveryDTO = {
  id: string;
  destinationId: string;
  status: string;
  attemptCount: number;
  responseCode: number | null;
  lastError: string | null;
  deliveredAt: string | null;
  createdAt: string;
};

export type EventDetailDTO = EventDTO & { bodyRaw: string; deliveries: DeliveryDTO[] };

type EventRow = {
  id: string;
  sourceId: string;
  method: string;
  receivedAt: Date;
  remoteIp: string | null;
  idempotencyKey: string | null;
};

function toDTO(e: EventRow): EventDTO {
  return {
    id: e.id,
    sourceId: e.sourceId,
    method: e.method,
    receivedAt: e.receivedAt.toISOString(),
    remoteIp: e.remoteIp,
    idempotencyKey: e.idempotencyKey,
  };
}

export async function listEvents(
  userId: string,
  page: Page,
): Promise<{ data: EventDTO[]; nextCursor: string | null }> {
  const rows = await prisma.event.findMany({
    where: { source: { userId } },
    orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
    take: page.limit,
    ...(page.cursor ? { cursor: { id: page.cursor }, skip: 1 } : {}),
  });
  const nextCursor = rows.length === page.limit ? rows[rows.length - 1].id : null;
  return { data: rows.map(toDTO), nextCursor };
}

export async function getEvent(userId: string, id: string): Promise<EventDetailDTO | null> {
  const row = await prisma.event.findFirst({
    where: { id, source: { userId } },
    include: { deliveries: { orderBy: { createdAt: "desc" } } },
  });
  if (!row) return null;
  return {
    ...toDTO(row),
    bodyRaw: row.bodyRaw,
    deliveries: row.deliveries.map((d) => ({
      id: d.id,
      destinationId: d.destinationId,
      status: d.status,
      attemptCount: d.attemptCount,
      responseCode: d.responseCode,
      lastError: d.lastError,
      deliveredAt: d.deliveredAt ? d.deliveredAt.toISOString() : null,
      createdAt: d.createdAt.toISOString(),
    })),
  };
}
