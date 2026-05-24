import { NextResponse } from "next/server";

import { auth } from "@/auth";
import { parseBulkIds } from "@/lib/bulk-events";
import { prisma } from "@/lib/prisma";
import { getDeliveryQueue } from "@/lib/queue";
import { checkReplayRateLimit } from "@/lib/ratelimit";

export const runtime = "nodejs";

/**
 * Bulk variant of POST /api/events/[id]/replay. Selection is capped at
 * BULK_MAX_IDS (50). Charges one replay-rate-limit token regardless of
 * how many events the call replays — the cap keeps the worst case bounded.
 */
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Match the single-event replay behaviour: rate-limiter failures fail open
  // so a flaky Redis doesn't block human-driven actions.
  try {
    const rl = await checkReplayRateLimit(session.user.id);
    if (!rl.allowed) {
      const retryAfterSec = Math.max(1, Math.ceil(rl.retryAfterMs / 1000));
      return NextResponse.json(
        { error: "rate limited" },
        {
          status: 429,
          headers: {
            "Retry-After": String(retryAfterSec),
            "X-RateLimit-Remaining": "0",
          },
        },
      );
    }
  } catch (err) {
    console.error("[bulk-replay] rate limiter error (failing open):", err);
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

  // Single query establishes ownership AND fetches the current enabled routes
  // per event. Anything we don't get back is silently dropped and counted as
  // `skipped`. Route filter matches ingest's: skip routes whose destination
  // is paused, since fresh deliveries against a paused dest would be
  // immediately exhausted by the worker.
  const events = await prisma.event.findMany({
    where: {
      id: { in: parsed.ids },
      source: { userId: session.user.id },
    },
    include: {
      source: {
        include: {
          routes: {
            where: { enabled: true, destination: { enabled: true } },
          },
        },
      },
    },
  });

  type CreateData = { eventId: string; destinationId: string; status: "pending" };
  const toCreate: CreateData[] = [];
  for (const e of events) {
    for (const r of e.source.routes) {
      toCreate.push({ eventId: e.id, destinationId: r.destinationId, status: "pending" });
    }
  }

  if (toCreate.length === 0) {
    return NextResponse.json({
      ok: true,
      eventsReplayed: 0,
      deliveriesCreated: 0,
      skipped: parsed.ids.length,
    });
  }

  // Use $transaction with an array of creates so we get back ids for the
  // queue.add fan-out. Bounded at BULK_MAX_IDS * destinations-per-source —
  // well under any Postgres / Prisma transaction limit.
  const created = await prisma.$transaction(
    toCreate.map((data) =>
      prisma.delivery.create({ data, select: { id: true } }),
    ),
  );

  const queue = getDeliveryQueue();
  await Promise.all(
    created.map((d) => queue.add("deliver", { deliveryId: d.id })),
  );

  const eventsReplayed = new Set(toCreate.map((d) => d.eventId)).size;
  return NextResponse.json({
    ok: true,
    eventsReplayed,
    deliveriesCreated: created.length,
    skipped: parsed.ids.length - eventsReplayed,
  });
}
