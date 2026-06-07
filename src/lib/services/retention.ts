import { prisma } from "@/lib/prisma";

export interface PurgeResult {
  /** Sources that had a (non-null) retention window and were scanned. */
  sourcesProcessed: number;
  /** Events deleted across all sources (deliveries cascade-delete with them). */
  eventsDeleted: number;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Enforce per-source data retention: delete events (and, by `onDelete: Cascade`,
 * their deliveries + AI diffs/diagnoses) older than each source's
 * `retentionDays`. Sources with null retention are kept indefinitely and
 * skipped. Idempotent — safe to run repeatedly; a second run within the same
 * window deletes nothing new.
 *
 * `now` is injectable for deterministic tests.
 */
export async function purgeExpiredEvents(now: Date = new Date()): Promise<PurgeResult> {
  const sources = await prisma.source.findMany({
    where: { retentionDays: { not: null } },
    select: { id: true, retentionDays: true },
  });

  let eventsDeleted = 0;
  for (const s of sources) {
    // retentionDays is non-null by the WHERE above; guard for the type system.
    if (s.retentionDays == null) continue;
    const cutoff = new Date(now.getTime() - s.retentionDays * MS_PER_DAY);
    const res = await prisma.event.deleteMany({
      where: { sourceId: s.id, receivedAt: { lt: cutoff } },
    });
    eventsDeleted += res.count;
  }

  return { sourcesProcessed: sources.length, eventsDeleted };
}
