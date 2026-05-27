import { Prisma } from "@/generated/prisma/client";

import { prisma } from "../prisma";

import { granularityFor, windowStart, zeroFill } from "./buckets";
import type { BucketGranularity, MetricsQueryParams } from "./types";

// Allow-listed Postgres date_trunc precision strings. We never interpolate
// raw user input — only one of these constants.
const TRUNC_PRECISION: Record<BucketGranularity, string> = {
  minute: "minute",
  hour: "hour",
  day: "day",
};

// Build a `date_trunc` expression that handles the "multiple" case
// (e.g. 15-minute buckets) by flooring epoch seconds.
function truncSqlFor(granularity: BucketGranularity, multiple: number): Prisma.Sql {
  if (multiple === 1) {
    // Safe: TRUNC_PRECISION values are constants, never user input.
    return Prisma.raw(`date_trunc('${TRUNC_PRECISION[granularity]}', "receivedAt")`);
  }
  // For multi-N buckets we floor by seconds.
  const seconds =
    granularity === "minute" ? 60 * multiple :
    granularity === "hour"   ? 3600 * multiple :
                               86400 * multiple;
  return Prisma.raw(
    `to_timestamp(floor(extract(epoch from "receivedAt") / ${seconds}) * ${seconds})`,
  );
}

export interface ThroughputRow {
  bucket: Date;
  count: number;
}

export async function getThroughput(
  p: MetricsQueryParams,
): Promise<ThroughputRow[]> {
  const spec = granularityFor(p.since);
  const start = windowStart(p.since);
  const end = new Date();
  const trunc = truncSqlFor(spec.granularity, spec.multiple);

  const sourceFilter = p.sourceId
    ? Prisma.sql`AND e."sourceId" = ${p.sourceId}`
    : Prisma.empty;
  // When scoping to a destination we count Delivery rows for that
  // destination (one row per Event×destination), which represents events
  // that were actually forwarded there.
  const destJoin = p.destinationId
    ? Prisma.sql`JOIN "Delivery" d ON d."eventId" = e.id`
    : Prisma.empty;
  const destFilter = p.destinationId
    ? Prisma.sql`AND d."destinationId" = ${p.destinationId}`
    : Prisma.empty;

  const rows = await prisma.$queryRaw<Array<{ bucket: Date; count: bigint }>>(
    Prisma.sql`
      SELECT ${trunc} AS bucket, count(*)::bigint AS count
      FROM "Event" e
      JOIN "Source" s ON s.id = e."sourceId"
      ${destJoin}
      WHERE s."userId" = ${p.userId}
        AND e."receivedAt" >= ${start}
        ${sourceFilter}
        ${destFilter}
      GROUP BY 1
      ORDER BY 1
    `,
  );

  return zeroFill<{ count: number }>(
    rows.map((r) => ({ bucket: r.bucket, count: Number(r.count) })),
    start,
    end,
    spec,
    { count: 0 },
  );
}

export interface SuccessRateRow {
  bucket: Date;
  delivered: number;
  failed: number;
}

export async function getSuccessRate(
  p: MetricsQueryParams,
): Promise<SuccessRateRow[]> {
  const spec = granularityFor(p.since);
  const start = windowStart(p.since);
  const end = new Date();
  // For the success-rate query the bucket dimension is the event's
  // receivedAt — delivered/failed are computed via FILTER on Delivery.
  const trunc = truncSqlFor(spec.granularity, spec.multiple);

  const sourceFilter = p.sourceId
    ? Prisma.sql`AND e."sourceId" = ${p.sourceId}`
    : Prisma.empty;
  const destFilter = p.destinationId
    ? Prisma.sql`AND d."destinationId" = ${p.destinationId}`
    : Prisma.empty;

  const rows = await prisma.$queryRaw<Array<{
    bucket: Date;
    delivered: bigint;
    failed: bigint;
  }>>(
    Prisma.sql`
      SELECT
        ${trunc} AS bucket,
        COUNT(*) FILTER (WHERE d.status = 'delivered')::bigint AS delivered,
        COUNT(*) FILTER (WHERE d.status IN ('failed','exhausted'))::bigint AS failed
      FROM "Delivery" d
      JOIN "Event" e ON e.id = d."eventId"
      JOIN "Source" s ON s.id = e."sourceId"
      WHERE s."userId" = ${p.userId}
        AND e."receivedAt" >= ${start}
        AND d.status IN ('delivered','failed','exhausted')
        ${sourceFilter}
        ${destFilter}
      GROUP BY 1
      ORDER BY 1
    `,
  );

  return zeroFill<{ delivered: number; failed: number }>(
    rows.map((r) => ({
      bucket: r.bucket,
      delivered: Number(r.delivered),
      failed: Number(r.failed),
    })),
    start,
    end,
    spec,
    { delivered: 0, failed: 0 },
  );
}

export interface LatencyRow {
  bucket: Date;
  p50: number | null;
  p95: number | null;
}

export async function getLatency(
  p: MetricsQueryParams,
): Promise<LatencyRow[]> {
  const spec = granularityFor(p.since);
  const start = windowStart(p.since);
  const end = new Date();
  const trunc = truncSqlFor(spec.granularity, spec.multiple);

  const sourceFilter = p.sourceId
    ? Prisma.sql`AND e."sourceId" = ${p.sourceId}`
    : Prisma.empty;
  const destFilter = p.destinationId
    ? Prisma.sql`AND d."destinationId" = ${p.destinationId}`
    : Prisma.empty;

  const rows = await prisma.$queryRaw<Array<{
    bucket: Date;
    p50: number | null;
    p95: number | null;
  }>>(
    Prisma.sql`
      SELECT
        ${trunc} AS bucket,
        percentile_cont(0.5) WITHIN GROUP (
          ORDER BY EXTRACT(epoch FROM (d."deliveredAt" - e."receivedAt")) * 1000
        ) AS p50,
        percentile_cont(0.95) WITHIN GROUP (
          ORDER BY EXTRACT(epoch FROM (d."deliveredAt" - e."receivedAt")) * 1000
        ) AS p95
      FROM "Delivery" d
      JOIN "Event" e ON e.id = d."eventId"
      JOIN "Source" s ON s.id = e."sourceId"
      WHERE s."userId" = ${p.userId}
        AND e."receivedAt" >= ${start}
        AND d.status = 'delivered'
        AND d."deliveredAt" IS NOT NULL
        ${sourceFilter}
        ${destFilter}
      GROUP BY 1
      ORDER BY 1
    `,
  );

  return zeroFill<{ p50: number | null; p95: number | null }>(
    rows.map((r) => ({
      bucket: r.bucket,
      p50: r.p50 === null ? null : Number(r.p50),
      p95: r.p95 === null ? null : Number(r.p95),
    })),
    start,
    end,
    spec,
    { p50: null, p95: null },
  );
}

export interface TopFailingRow {
  destinationId: string;
  name: string;
  failures: number;
  lastFailure: Date;
}

export async function getTopFailing(
  p: MetricsQueryParams,
): Promise<TopFailingRow[]> {
  const start = windowStart(p.since);

  const sourceFilter = p.sourceId
    ? Prisma.sql`AND e."sourceId" = ${p.sourceId}`
    : Prisma.empty;
  // destinationId filter doesn't make sense on this query (always returns
  // 1 row by definition), so it's omitted.

  const rows = await prisma.$queryRaw<Array<{
    destinationId: string;
    name: string;
    failures: bigint;
    lastFailure: Date;
  }>>(
    Prisma.sql`
      SELECT
        d."destinationId" AS "destinationId",
        dest.name,
        COUNT(*)::bigint AS failures,
        MAX(d."updatedAt") AS "lastFailure"
      FROM "Delivery" d
      JOIN "Destination" dest ON dest.id = d."destinationId"
      JOIN "Event" e ON e.id = d."eventId"
      WHERE dest."userId" = ${p.userId}
        AND d.status IN ('failed','exhausted')
        AND d."updatedAt" >= ${start}
        ${sourceFilter}
      GROUP BY 1, 2
      ORDER BY failures DESC, "lastFailure" DESC
      LIMIT 10
    `,
  );

  return rows.map((r) => ({
    destinationId: r.destinationId,
    name: r.name,
    failures: Number(r.failures),
    lastFailure: r.lastFailure,
  }));
}

export interface OverviewTotals {
  totalEvents: number;
  activeSources: number;
  successRate: number | null; // 0..100, or null when no terminal deliveries
  p95LatencyMs: number | null;
}

export async function getOverviewTotals(
  p: MetricsQueryParams,
): Promise<OverviewTotals> {
  const start = windowStart(p.since);

  // Four independent aggregates, parallelized.
  const [eventTotals, deliveryTotals, latency] = await Promise.all([
    prisma.$queryRaw<Array<{ events: bigint; sources: bigint }>>(
      Prisma.sql`
        SELECT
          COUNT(*)::bigint AS events,
          COUNT(DISTINCT e."sourceId")::bigint AS sources
        FROM "Event" e
        JOIN "Source" s ON s.id = e."sourceId"
        WHERE s."userId" = ${p.userId}
          AND e."receivedAt" >= ${start}
      `,
    ),
    prisma.$queryRaw<Array<{ delivered: bigint; failed: bigint }>>(
      Prisma.sql`
        SELECT
          COUNT(*) FILTER (WHERE d.status = 'delivered')::bigint AS delivered,
          COUNT(*) FILTER (WHERE d.status IN ('failed','exhausted'))::bigint AS failed
        FROM "Delivery" d
        JOIN "Event" e ON e.id = d."eventId"
        JOIN "Source" s ON s.id = e."sourceId"
        WHERE s."userId" = ${p.userId}
          AND e."receivedAt" >= ${start}
          AND d.status IN ('delivered','failed','exhausted')
      `,
    ),
    prisma.$queryRaw<Array<{ p95: number | null }>>(
      Prisma.sql`
        SELECT
          percentile_cont(0.95) WITHIN GROUP (
            ORDER BY EXTRACT(epoch FROM (d."deliveredAt" - e."receivedAt")) * 1000
          ) AS p95
        FROM "Delivery" d
        JOIN "Event" e ON e.id = d."eventId"
        JOIN "Source" s ON s.id = e."sourceId"
        WHERE s."userId" = ${p.userId}
          AND e."receivedAt" >= ${start}
          AND d.status = 'delivered'
          AND d."deliveredAt" IS NOT NULL
      `,
    ),
  ]);

  const ev = eventTotals[0] ?? { events: BigInt(0), sources: BigInt(0) };
  const dv = deliveryTotals[0] ?? { delivered: BigInt(0), failed: BigInt(0) };
  const lat = latency[0] ?? { p95: null };
  const delivered = Number(dv.delivered);
  const failed = Number(dv.failed);
  const denom = delivered + failed;

  return {
    totalEvents: Number(ev.events),
    activeSources: Number(ev.sources),
    successRate: denom === 0 ? null : (delivered / denom) * 100,
    p95LatencyMs: lat.p95 === null ? null : Number(lat.p95),
  };
}
