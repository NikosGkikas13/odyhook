import { NextResponse } from "next/server";

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { getDeliveryQueue } from "@/lib/queue";
import { checkReplayRateLimit } from "@/lib/ratelimit";
import { isAllowedOrigin } from "@/lib/csrf";

export const runtime = "nodejs";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  // CSRF: this route is cookie-authed; require a same-origin request.
  if (!isAllowedOrigin(req)) {
    return NextResponse.json({ error: "bad origin" }, { status: 403 });
  }

  // Per-user replay budget. Fails open on Redis errors — replay is a
  // human-triggered action and we'd rather a flaky cache not block it.
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
    console.error("[replay] rate limiter error (failing open):", err);
  }

  const { id } = await ctx.params;

  const event = await prisma.event.findUnique({
    where: { id },
    include: {
      source: {
        include: {
          routes: {
            where: { enabled: true },
          },
        },
      },
    },
  });

  if (!event || event.source.userId !== session.user.id) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Create fresh pending deliveries against the *current* route set,
  // so replays honor routing changes made since the original delivery.
  const created = await prisma.$transaction(
    event.source.routes.map((r) =>
      prisma.delivery.create({
        data: {
          eventId: event.id,
          destinationId: r.destinationId,
          status: "pending",
        },
      }),
    ),
  );

  const queue = getDeliveryQueue();
  await Promise.all(
    created.map((d) => queue.add("deliver", { deliveryId: d.id })),
  );

  return NextResponse.json({ ok: true, deliveries: created.length });
}
