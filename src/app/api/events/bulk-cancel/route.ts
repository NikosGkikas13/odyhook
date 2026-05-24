import { NextResponse } from "next/server";

import { auth } from "@/auth";
import { parseBulkIds } from "@/lib/bulk-events";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

/**
 * Bulk cancel: flip non-terminal deliveries on the selected events to
 * `exhausted` with a "cancelled by user" marker. Doesn't touch BullMQ jobs
 * directly — the worker short-circuits on `exhausted` at delivery.ts:86-88,
 * so any queued/delayed jobs become no-ops on pickup.
 *
 * No rate limit: this is a pure DB write that creates no worker work.
 */
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = parseBulkIds(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  // Ownership enforced via the nested relation filter: the WHERE traverses
  // delivery.event.source.userId, so a delivery belonging to another user
  // simply isn't included in the update set. Verified against
  // DeliveryWhereInput in Prisma 7's generated types.
  const result = await prisma.delivery.updateMany({
    where: {
      eventId: { in: parsed.ids },
      event: { source: { userId: session.user.id } },
      status: { in: ["pending", "in_flight", "failed"] },
    },
    data: {
      status: "exhausted",
      lastError: "cancelled by user",
      nextRetryAt: null,
    },
  });

  return NextResponse.json({ ok: true, cancelled: result.count });
}
