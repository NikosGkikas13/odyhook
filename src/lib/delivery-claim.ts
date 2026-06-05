import { prisma } from "@/lib/prisma";

// A delivery sits in `in_flight` only while a worker is actively processing it:
// claim → fetch (bounded by the per-destination timeout, default 10s) →
// terminal update. If a row is still `in_flight` long past that window, the
// worker that claimed it died or threw after the claim, so the row is orphaned
// and safe to re-claim. This grace must comfortably exceed one fetch+write
// cycle so a live-but-slow worker is never mistaken for a dead one.
export const IN_FLIGHT_GRACE_MS = Number(
  process.env.DELIVERY_IN_FLIGHT_GRACE_MS ?? 300_000, // 5 minutes
);

/**
 * Atomically claim a delivery for processing, moving it to `in_flight`.
 *
 * Compare-and-swap: the row is only claimed if it is currently claimable —
 * `pending`/`failed`, or an *orphaned* `in_flight` row whose last update
 * predates `staleInFlightBefore` (its previous worker died/threw without
 * finishing). Returns true iff this caller won the claim. Concurrent callers
 * (e.g. the original slow job vs. a reaper re-enqueue) see count 0 and must
 * bail so the destination is only POSTed once. `delivered`/`exhausted` rows
 * are terminal and never re-claimed.
 *
 * `@updatedAt` is bumped to now on the winning write, which doubles as the
 * fresh in-flight timestamp the staleness check reads.
 */
export async function claimDelivery(
  deliveryId: string,
  staleInFlightBefore: Date = new Date(Date.now() - IN_FLIGHT_GRACE_MS),
): Promise<boolean> {
  const { count } = await prisma.delivery.updateMany({
    where: {
      id: deliveryId,
      OR: [
        { status: { in: ["pending", "failed"] } },
        { status: "in_flight", updatedAt: { lt: staleInFlightBefore } },
      ],
    },
    data: { status: "in_flight" },
  });
  return count > 0;
}

/**
 * Find deliveries that have stalled and need re-enqueueing:
 *  - `pending` rows older than `pendingBefore` — the enqueue failed after the
 *    row was created (Redis hiccup / crash between create and `queue.add`).
 *  - `in_flight` rows older than `inFlightBefore` — a worker claimed the row
 *    then died/threw before writing a terminal status (orphaned). The CAS in
 *    `claimDelivery` keeps the re-enqueue from double-delivering.
 *
 * Pending staleness is measured from `createdAt` (the row never advanced);
 * in-flight staleness from `updatedAt` (when it was claimed), so a retry that
 * was created long ago but only just claimed is not mistaken for an orphan.
 */
export async function findStalledDeliveryIds(opts: {
  pendingBefore: Date;
  inFlightBefore: Date;
  take: number;
}): Promise<string[]> {
  const rows = await prisma.delivery.findMany({
    where: {
      OR: [
        { status: "pending", createdAt: { lt: opts.pendingBefore } },
        { status: "in_flight", updatedAt: { lt: opts.inFlightBefore } },
      ],
    },
    select: { id: true },
    take: opts.take,
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => r.id);
}
