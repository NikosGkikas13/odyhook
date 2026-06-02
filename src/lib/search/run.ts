import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { evaluateFilter } from "@/lib/filters/evaluator";
import { buildEventWhere } from "./where";
import type { EventQuery } from "./types";

export const SCAN_CAP = 2000; // max metadata-matching rows scanned per request (payload path)
export const SCAN_BATCH = 200; // rows fetched per DB round-trip while scanning

const eventInclude = {
  source: { select: { name: true } },
  deliveries: { select: { status: true } },
} satisfies Prisma.EventInclude;

export type SearchResultEvent = Prisma.EventGetPayload<{ include: typeof eventInclude }>;

const ORDER_BY: Prisma.EventOrderByWithRelationInput[] = [
  { receivedAt: "desc" },
  { id: "desc" },
];

export type RunSearchOpts = {
  cursor?: string | null;
  limit?: number;
  scanCap?: number;
  scanBatch?: number;
};

export type RunSearchResult = {
  events: SearchResultEvent[];
  scanned: number;
  scanCapped: boolean;
  nextCursor: string | null;
};

export async function runEventSearch(
  userId: string,
  query: EventQuery,
  opts: RunSearchOpts = {},
): Promise<RunSearchResult> {
  const where = buildEventWhere(userId, query.metadata);
  const limit = Math.min(100, Math.max(1, opts.limit ?? 50));

  // Fast path: no payload predicate → plain keyset pagination.
  if (!query.payload) {
    const rows = await prisma.event.findMany({
      where,
      orderBy: ORDER_BY,
      include: eventInclude,
      take: limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const events = hasMore ? rows.slice(0, limit) : rows;
    return {
      events,
      scanned: events.length,
      scanCapped: false,
      nextCursor: hasMore ? events[events.length - 1].id : null,
    };
  }

  // Payload path: scan newest-first in batches, evaluate the AST in memory.
  const payload = query.payload;
  const scanCap = opts.scanCap ?? SCAN_CAP;
  const scanBatch = opts.scanBatch ?? SCAN_BATCH;

  const matches: SearchResultEvent[] = [];
  let scanned = 0;
  let cursor = opts.cursor ?? null;
  let lastScannedId: string | null = null;
  let exhausted = false;

  while (matches.length <= limit && scanned < scanCap) {
    const take = Math.min(scanBatch, scanCap - scanned);
    const batch = await prisma.event.findMany({
      where,
      orderBy: ORDER_BY,
      include: eventInclude,
      take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (batch.length === 0) { exhausted = true; break; }

    for (const row of batch) {
      scanned++;
      lastScannedId = row.id;
      let parsed: unknown;
      try { parsed = JSON.parse(row.bodyRaw); } catch { continue; }
      if (evaluateFilter(payload, parsed)) {
        matches.push(row);
        if (matches.length > limit) break;
      }
    }
    cursor = lastScannedId;
    if (batch.length < take) { exhausted = true; break; }
    if (matches.length > limit) break;
  }

  const hasMore = matches.length > limit;
  const events = hasMore ? matches.slice(0, limit) : matches;
  const scanCapped = !hasMore && !exhausted && scanned >= scanCap;
  const nextCursor = hasMore
    ? events[events.length - 1].id // resume after the last returned match
    : scanCapped
      ? lastScannedId // resume scanning older rows
      : null;

  return { events, scanned, scanCapped, nextCursor };
}
