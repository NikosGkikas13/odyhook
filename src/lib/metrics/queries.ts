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

  const rows = await prisma.$queryRaw<Array<{ bucket: Date; count: bigint }>>(
    Prisma.sql`
      SELECT ${trunc} AS bucket, count(*)::bigint AS count
      FROM "Event" e
      JOIN "Source" s ON s.id = e."sourceId"
      WHERE s."userId" = ${p.userId}
        AND e."receivedAt" >= ${start}
        ${sourceFilter}
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
