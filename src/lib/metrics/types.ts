// Quick-pick time windows for the metrics surface. Matches the conventions
// used by the events page (src/components/events-filter.tsx).
export type SinceWindow = "1h" | "24h" | "7d" | "30d";

export const DEFAULT_SINCE: SinceWindow = "24h";

export const SINCE_VALUES: ReadonlySet<SinceWindow> = new Set([
  "1h",
  "24h",
  "7d",
  "30d",
]);

// Granularity strings we pass to Postgres `date_trunc`. Allow-listed to
// prevent SQL injection — see queries.ts.
export type BucketGranularity = "minute" | "hour" | "day";

// Bucket size as an interval, used to derive the snap-back start of the
// window and to zero-fill empty buckets.
export interface BucketSpec {
  granularity: BucketGranularity;
  // How many of `granularity` make up one displayed bucket. e.g. for 24h we
  // bucket by 15 minutes -> { granularity: "minute", multiple: 15 }.
  multiple: number;
}

// Shape every chart-data query returns: one row per bucket, oldest first.
export interface BucketedRow<T> {
  bucket: Date;
  data: T;
}

// Common filter argument to every query function.
export interface MetricsQueryParams {
  userId: string;
  since: SinceWindow;
  sourceId?: string;
  destinationId?: string;
}
