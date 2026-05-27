import type { BucketSpec, SinceWindow } from "./types";

export function granularityFor(since: SinceWindow): BucketSpec {
  switch (since) {
    case "1h":
      return { granularity: "minute", multiple: 1 };
    case "24h":
      return { granularity: "minute", multiple: 15 };
    case "7d":
      return { granularity: "hour", multiple: 1 };
    case "30d":
      return { granularity: "hour", multiple: 6 };
  }
}

const SINCE_MS: Record<SinceWindow, number> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

export function windowStart(since: SinceWindow, now: Date = new Date()): Date {
  return new Date(now.getTime() - SINCE_MS[since]);
}

function bucketSizeMs(spec: BucketSpec): number {
  const unit = spec.granularity === "minute" ? 60_000 : spec.granularity === "hour" ? 3_600_000 : 86_400_000;
  return unit * spec.multiple;
}

function floorToBucket(d: Date, spec: BucketSpec): Date {
  const size = bucketSizeMs(spec);
  return new Date(Math.floor(d.getTime() / size) * size);
}

export function zeroFill<T>(
  rows: Array<{ bucket: Date } & T>,
  start: Date,
  end: Date,
  spec: BucketSpec,
  empty: T,
): Array<{ bucket: Date } & T> {
  const size = bucketSizeMs(spec);
  const first = floorToBucket(start, spec).getTime();
  // Include the current in-progress bucket (`end` is "now"). Without `<=`
  // the partial bucket would silently drop the most recent events.
  const last = floorToBucket(end, spec).getTime();
  const byMs = new Map<number, { bucket: Date } & T>();
  for (const r of rows) byMs.set(r.bucket.getTime(), r);

  const out: Array<{ bucket: Date } & T> = [];
  for (let t = first; t <= last; t += size) {
    const found = byMs.get(t);
    if (found) out.push(found);
    else out.push({ bucket: new Date(t), ...empty });
  }
  return out;
}
