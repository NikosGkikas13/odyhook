import { withApiAuth, apiError } from "@/lib/api/handler";
import { prisma } from "@/lib/prisma";
import { getConnection } from "@/lib/queue";
import { eventChannel, type LiveEvent } from "@/lib/events-pubsub";
import { acquireSseSlot, releaseSseSlot } from "@/lib/sse-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 25_000;

export const GET = withApiAuth(async (req, auth) => {
  const url = new URL(req.url);
  const slug = url.searchParams.get("source");
  if (!slug) return apiError("validation_error", "missing ?source=<slug>");

  const source = await prisma.source.findFirst({
    where: { slug, userId: auth.userId },
    select: { id: true },
  });
  if (!source) return apiError("not_found", "source not found");

  // Cap concurrent streams per user: each one pins a Redis connection and a
  // heartbeat timer for its whole lifetime, and withApiAuth limits only the
  // *rate* of opening, not the *count* held open.
  if (!acquireSseSlot(auth.userId)) {
    return apiError(
      "rate_limited",
      "too many concurrent /listen streams for this account",
    );
  }

  const lastEventId = req.headers.get("last-event-id");
  const sub = getConnection().duplicate();
  const encoder = new TextEncoder();

  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let released = false;
  const cleanup = async () => {
    // Release the concurrency slot exactly once (cleanup may fire from the
    // abort listener, stream cancel, and the send/heartbeat error paths).
    if (!released) {
      released = true;
      releaseSseSlot(auth.userId);
    }
    if (heartbeat) clearInterval(heartbeat);
    try {
      await sub.unsubscribe();
      await sub.quit();
    } catch {
      /* already closed */
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (evt: LiveEvent) => {
        controller.enqueue(
          encoder.encode(`id: ${evt.id}\ndata: ${JSON.stringify(evt)}\n\n`),
        );
      };

      // Live messages that arrive while we're still backfilling are buffered,
      // not sent, so (a) they aren't interleaved before the older backfill
      // events and (b) the window between the backfill snapshot and going
      // live can't silently drop them. Flushed in order once backfill is done.
      const buffer: LiveEvent[] = [];
      let buffering = true;
      sub.on("message", (_chan, msg) => {
        let evt: LiveEvent;
        try {
          evt = JSON.parse(msg) as LiveEvent;
        } catch {
          return; // ignore malformed messages
        }
        if (buffering) {
          buffer.push(evt);
          return;
        }
        try {
          send(evt);
        } catch {
          // Controller already closed/cancelled — tear down (symmetric with heartbeat).
          void cleanup();
        }
      });

      // Subscribe BEFORE the backfill query. An event committed during or
      // after the backfill snapshot is then captured by the subscription
      // (buffered above) instead of falling into the gap between the snapshot
      // and a later subscribe, where it would belong to neither set.
      await sub.subscribe(eventChannel(source.id));

      // Backfill anything that arrived while the client was disconnected.
      const backfilledIds = new Set<string>();
      if (lastEventId) {
        // Scope the marker to the caller's own source. An unscoped findUnique
        // would let any event id act as a timestamp/existence oracle (a global
        // id leaks whether it exists and shifts this caller's backfill window).
        const marker = await prisma.event.findFirst({
          where: { id: lastEventId, sourceId: source.id },
          select: { receivedAt: true },
        });
        if (marker) {
          const missed = await prisma.event.findMany({
            where: { sourceId: source.id, receivedAt: { gt: marker.receivedAt } },
            orderBy: { receivedAt: "asc" },
            select: {
              id: true,
              method: true,
              headersJson: true,
              bodyRaw: true,
              receivedAt: true,
            },
          });
          for (const e of missed) {
            backfilledIds.add(e.id);
            send({
              id: e.id,
              method: e.method,
              headersJson: e.headersJson as Record<string, string>,
              bodyRaw: e.bodyRaw,
              receivedAt: e.receivedAt.toISOString(),
            });
          }
        }
      }

      // Flush events buffered during backfill, skipping any the backfill query
      // already delivered (an event committed between subscribe and the
      // snapshot appears in both), then go live. This runs synchronously — no
      // await — so no live message can interleave before the flush completes.
      for (const evt of buffer) {
        if (backfilledIds.has(evt.id)) continue;
        try {
          send(evt);
        } catch {
          void cleanup();
          break;
        }
      }
      buffer.length = 0;
      buffering = false;

      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          // Controller already closed/cancelled — stop and tear down.
          void cleanup();
        }
      }, HEARTBEAT_MS);

      req.signal.addEventListener("abort", () => {
        void cleanup().then(() => {
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        });
      });
    },
    async cancel() {
      await cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});
