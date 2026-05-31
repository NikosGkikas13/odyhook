import { withApiAuth, apiError } from "@/lib/api/handler";
import { prisma } from "@/lib/prisma";
import { getConnection } from "@/lib/queue";
import { eventChannel, type LiveEvent } from "@/lib/events-pubsub";

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

  const lastEventId = req.headers.get("last-event-id");
  const sub = getConnection().duplicate();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (evt: LiveEvent) => {
        controller.enqueue(
          encoder.encode(`id: ${evt.id}\ndata: ${JSON.stringify(evt)}\n\n`),
        );
      };

      // Backfill anything that arrived while the client was disconnected.
      if (lastEventId) {
        const marker = await prisma.event.findUnique({
          where: { id: lastEventId },
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

      await sub.subscribe(eventChannel(source.id));
      sub.on("message", (_chan, msg) => {
        try {
          send(JSON.parse(msg) as LiveEvent);
        } catch {
          /* ignore malformed messages */
        }
      });

      const heartbeat = setInterval(() => {
        controller.enqueue(encoder.encode(`: ping\n\n`));
      }, HEARTBEAT_MS);

      const close = async () => {
        clearInterval(heartbeat);
        try {
          await sub.unsubscribe();
          await sub.quit();
        } catch {
          /* already closed */
        }
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      req.signal.addEventListener("abort", () => void close());
    },
    async cancel() {
      try {
        await sub.quit();
      } catch {
        /* already closed */
      }
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
