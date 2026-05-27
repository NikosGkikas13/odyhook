# Metrics Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a metrics surface with four widgets (throughput, success rate, p50/p95 latency, top failing destinations) on a new `/overview` landing page, plus per-source and per-destination drilldowns.

**Architecture:** Server components run live SQL aggregations against existing `Event` and `Delivery` tables (no rollups, no new schema). Time-bucketed queries via `prisma.$queryRaw` + `date_trunc`. Client-side charts via Recharts. Page caching via Next 16's `revalidate: 60`.

**Tech Stack:** Next.js 16 App Router, Prisma 7 + Postgres, Recharts (new dep), Tailwind 4, Vitest.

**Spec:** [`docs/superpowers/specs/2026-05-27-metrics-dashboard-design.md`](../specs/2026-05-27-metrics-dashboard-design.md)

---

## Conventions to follow

- Existing tests load `.env` for the dev Postgres via `import "dotenv/config"` at the top of any test that hits Prisma. See [src/lib/circuit-breaker.test.ts:5](../../../src/lib/circuit-breaker.test.ts) for the convention.
- DB tests create a unique user and clean it up in `finally { await prisma.user.delete({ where: { id: u.id } }) }`. `onDelete: Cascade` handles related rows.
- Server components in `(dashboard)/` use `export const dynamic = "force-dynamic"` (existing pages) **or** `export const revalidate = N` — pick one per page. For metrics pages we use `revalidate = 60`.
- Card shell pattern used across the app: `rounded-lg border border-zinc-200 bg-white p-4 sm:p-6 dark:border-zinc-700 dark:bg-zinc-900`.
- Brand color CSS var: `--brand-blue-fg`. Defined for both light and dark themes in [src/app/globals.css](../../../src/app/globals.css).

---

## File structure

New files:
- `src/lib/metrics/types.ts` — shared types (`SinceWindow`, `BucketGranularity`, query-param shapes)
- `src/lib/metrics/buckets.ts` — pure functions: `granularityFor(window)`, `zeroFill(rows, start, end, granularity)`
- `src/lib/metrics/buckets.test.ts`
- `src/lib/metrics/queries.ts` — five Prisma `$queryRaw` query functions + four KPI queries
- `src/lib/metrics/queries.test.ts`
- `src/components/metrics/format.ts` — shared chart formatters (`formatTimestamp`)
- `src/components/metrics/chart-card.tsx` — shared card shell (server component, no client deps)
- `src/components/metrics/stat-card.tsx` — KPI tile (server component)
- `src/components/metrics/time-window-selector.tsx` — pill buttons via `<Link>` (server component)
- `src/components/metrics/refresh-button.tsx` — client component, calls `router.refresh()`
- `src/components/metrics/throughput-chart.tsx` — Recharts AreaChart (client)
- `src/components/metrics/success-rate-chart.tsx` — Recharts LineChart (client)
- `src/components/metrics/latency-chart.tsx` — Recharts LineChart, 2 lines (client)
- `src/components/metrics/top-failing-table.tsx` — plain HTML table (server)
- `src/app/(dashboard)/overview/page.tsx`
- `src/app/(dashboard)/overview/error.tsx`
- `src/app/(dashboard)/sources/[id]/page.tsx`
- `src/app/(dashboard)/sources/[id]/error.tsx`
- `src/app/(dashboard)/destinations/[id]/error.tsx`

Modified files:
- `package.json` — add `recharts` dep
- `src/app/globals.css` — add `--chart-grid` + `--chart-line` vars
- `src/app/(dashboard)/destinations/[id]/page.tsx` — add metrics widgets above existing alert form
- `src/app/(dashboard)/sources/page.tsx` — wrap each source row in a link to `/sources/[id]`
- `src/app/(dashboard)/layout.tsx` — change logo `<Link href="/sources">` to `"/overview"`
- `src/components/nav-links.tsx` — prepend `Overview` nav item
- `src/app/signin/page.tsx` — change default redirect from `/sources` to `/overview`

---

## Task 0: Branch + Recharts install

**Files:** `package.json`, `package-lock.json`

- [ ] **Step 1: Create a feature branch off main**

```bash
git checkout main
git pull --ff-only
git checkout -b feat/metrics-dashboard
```

- [ ] **Step 2: Install Recharts**

Recharts is a peer-friendly React chart library. Use the latest 3.x release.

```bash
npm install recharts
```

- [ ] **Step 3: Verify it's listed in dependencies**

```bash
grep recharts package.json
```

Expected: a line like `"recharts": "^3.x.x"` under `"dependencies"`.

- [ ] **Step 4: Verify the dev build still passes**

```bash
npm run build
```

Expected: build completes without errors. (We haven't imported recharts yet so this should pass cleanly.)

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat(metrics): install recharts for dashboard charts"
```

---

## Task 1: CSS variables for chart theming

**Files:** Modify `src/app/globals.css`

Recharts elements read colors from inline `stroke="var(...)"` props. We need two vars that resolve correctly under light and dark mode.

- [ ] **Step 1: Locate the brand-blue-fg vars**

Existing CSS already defines `--brand-blue-fg` twice: at [src/app/globals.css:71](../../../src/app/globals.css#L71) for light mode and around line 115 for dark mode. Add the new vars next to each definition.

Run to confirm line numbers haven't shifted:

```bash
grep -n "brand-blue-fg" src/app/globals.css
```

- [ ] **Step 2: Add `--chart-grid` and `--chart-line` to light mode**

Edit `src/app/globals.css`. Below the line `--brand-blue-fg: var(--brand-blue);` (in the `:root` block — light mode), add:

```css
  --chart-grid: var(--zinc-200);
  --chart-line: var(--brand-blue);
```

- [ ] **Step 3: Add `--chart-grid` and `--chart-line` to dark mode**

Below the line `--brand-blue-fg: #5B8DEF;` (in the `.dark` block), add:

```css
  --chart-grid: var(--zinc-800);
  --chart-line: #5B8DEF;
```

- [ ] **Step 4: Verify the file still parses (Tailwind builds it)**

```bash
npm run build
```

Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/app/globals.css
git commit -m "feat(metrics): add chart-grid and chart-line CSS vars"
```

---

## Task 2: Shared types

**Files:** Create `src/lib/metrics/types.ts`

- [ ] **Step 1: Create the types module**

Create `src/lib/metrics/types.ts`:

```typescript
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
```

- [ ] **Step 2: Verify TypeScript accepts it**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/metrics/types.ts
git commit -m "feat(metrics): shared types for metrics queries"
```

---

## Task 3: Bucket utilities (pure functions, TDD)

**Files:**
- Create: `src/lib/metrics/buckets.ts`
- Test: `src/lib/metrics/buckets.test.ts`

This module decides bucket size from window and zero-fills empty buckets.

- [ ] **Step 1: Write the failing test for `granularityFor`**

Create `src/lib/metrics/buckets.test.ts`:

```typescript
import { describe, it, expect } from "vitest";

import { granularityFor, zeroFill, windowStart } from "./buckets";

describe("granularityFor", () => {
  it("returns 1-minute buckets for 1h window", () => {
    expect(granularityFor("1h")).toEqual({ granularity: "minute", multiple: 1 });
  });

  it("returns 15-minute buckets for 24h window", () => {
    expect(granularityFor("24h")).toEqual({ granularity: "minute", multiple: 15 });
  });

  it("returns 1-hour buckets for 7d window", () => {
    expect(granularityFor("7d")).toEqual({ granularity: "hour", multiple: 1 });
  });

  it("returns 6-hour buckets for 30d window", () => {
    expect(granularityFor("30d")).toEqual({ granularity: "hour", multiple: 6 });
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
npm test -- buckets
```

Expected: FAIL — `Cannot find module './buckets'`.

- [ ] **Step 3: Implement `granularityFor`**

Create `src/lib/metrics/buckets.ts`:

```typescript
import type { BucketSpec, SinceWindow, BucketGranularity } from "./types";

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

// Placeholder — implemented in step 5.
export function windowStart(since: SinceWindow, now: Date = new Date()): Date {
  void since;
  return now;
}

// Placeholder — implemented in step 7.
export function zeroFill<T>(
  rows: Array<{ bucket: Date } & T>,
  _start: Date,
  _end: Date,
  _spec: BucketSpec,
  _empty: T,
): Array<{ bucket: Date } & T> {
  return rows;
}
```

- [ ] **Step 4: Run the test — `granularityFor` tests pass**

```bash
npm test -- buckets
```

Expected: `granularityFor` tests PASS. The next two tests (which we'll add now) don't exist yet.

- [ ] **Step 5: Add tests for `windowStart`**

Append to `src/lib/metrics/buckets.test.ts`:

```typescript
describe("windowStart", () => {
  it("returns now - 1h for a 1h window", () => {
    const now = new Date("2026-05-27T12:00:00Z");
    expect(windowStart("1h", now)).toEqual(new Date("2026-05-27T11:00:00Z"));
  });

  it("returns now - 24h for a 24h window", () => {
    const now = new Date("2026-05-27T12:00:00Z");
    expect(windowStart("24h", now)).toEqual(new Date("2026-05-26T12:00:00Z"));
  });

  it("returns now - 7d for a 7d window", () => {
    const now = new Date("2026-05-27T12:00:00Z");
    expect(windowStart("7d", now)).toEqual(new Date("2026-05-20T12:00:00Z"));
  });

  it("returns now - 30d for a 30d window", () => {
    const now = new Date("2026-05-27T12:00:00Z");
    expect(windowStart("30d", now)).toEqual(new Date("2026-04-27T12:00:00Z"));
  });
});
```

Run: `npm test -- buckets`. Expected: FAIL — `windowStart` returns `now`, not the offset.

- [ ] **Step 6: Implement `windowStart`**

Replace the placeholder in `src/lib/metrics/buckets.ts`:

```typescript
const SINCE_MS: Record<SinceWindow, number> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

export function windowStart(since: SinceWindow, now: Date = new Date()): Date {
  return new Date(now.getTime() - SINCE_MS[since]);
}
```

Run: `npm test -- buckets`. Expected: PASS.

- [ ] **Step 7: Add tests for `zeroFill`**

Append to `src/lib/metrics/buckets.test.ts`:

```typescript
describe("zeroFill", () => {
  const spec = { granularity: "minute" as BucketGranularity, multiple: 15 };
  const start = new Date("2026-05-27T11:00:00Z");
  const end = new Date("2026-05-27T12:00:00Z");

  it("fills empty buckets with the default value", () => {
    const result = zeroFill<{ count: number }>(
      [],
      start,
      end,
      spec,
      { count: 0 },
    );
    expect(result).toHaveLength(4); // 11:00, 11:15, 11:30, 11:45
    expect(result.every((r) => r.count === 0)).toBe(true);
    expect(result[0].bucket).toEqual(new Date("2026-05-27T11:00:00Z"));
    expect(result[3].bucket).toEqual(new Date("2026-05-27T11:45:00Z"));
  });

  it("preserves provided rows and fills gaps around them", () => {
    const result = zeroFill<{ count: number }>(
      [{ bucket: new Date("2026-05-27T11:15:00Z"), count: 42 }],
      start,
      end,
      spec,
      { count: 0 },
    );
    expect(result).toHaveLength(4);
    expect(result[0].count).toBe(0);
    expect(result[1].count).toBe(42);
    expect(result[2].count).toBe(0);
    expect(result[3].count).toBe(0);
  });

  it("aligns the first bucket to the granularity floor", () => {
    // start is mid-bucket (11:07) -> first bucket should snap back to 11:00.
    const result = zeroFill<{ count: number }>(
      [],
      new Date("2026-05-27T11:07:00Z"),
      new Date("2026-05-27T11:35:00Z"),
      spec,
      { count: 0 },
    );
    expect(result[0].bucket).toEqual(new Date("2026-05-27T11:00:00Z"));
  });
});
```

Add the `BucketGranularity` import at the top of the test file:

```typescript
import type { BucketGranularity } from "./types";
```

Run: `npm test -- buckets`. Expected: FAIL — `zeroFill` returns input unchanged.

- [ ] **Step 8: Implement `zeroFill`**

Replace the placeholder in `src/lib/metrics/buckets.ts`:

```typescript
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
  const last = floorToBucket(end, spec).getTime();
  const byMs = new Map<number, { bucket: Date } & T>();
  for (const r of rows) byMs.set(r.bucket.getTime(), r);

  const out: Array<{ bucket: Date } & T> = [];
  for (let t = first; t < last; t += size) {
    const found = byMs.get(t);
    if (found) out.push(found);
    else out.push({ bucket: new Date(t), ...empty });
  }
  return out;
}
```

Run: `npm test -- buckets`. Expected: PASS, all tests green.

- [ ] **Step 9: Commit**

```bash
git add src/lib/metrics/buckets.ts src/lib/metrics/buckets.test.ts
git commit -m "feat(metrics): bucket granularity + zero-fill utilities"
```

---

## Task 4: Throughput query

**Files:**
- Create: `src/lib/metrics/queries.ts`
- Test: `src/lib/metrics/queries.test.ts`

The first DB-backed query. Establishes the shared query test helpers we'll reuse for the next four queries.

- [ ] **Step 1: Write the failing test**

Create `src/lib/metrics/queries.test.ts`:

```typescript
import "dotenv/config";
import { describe, it, expect } from "vitest";

import { prisma } from "../prisma";
import { getThroughput } from "./queries";

async function makeUser() {
  return prisma.user.create({
    data: { email: `metrics-${Date.now()}-${Math.random()}@test.local` },
  });
}

async function makeSource(userId: string, name = "Stripe") {
  return prisma.source.create({
    data: {
      userId,
      name,
      slug: `metrics-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    },
  });
}

async function makeEvent(sourceId: string, receivedAt: Date) {
  return prisma.event.create({
    data: {
      sourceId,
      method: "POST",
      headersJson: {},
      bodyRaw: "{}",
      receivedAt,
    },
  });
}

describe("getThroughput", () => {
  it("returns one row per bucket with the event count", async () => {
    const u = await makeUser();
    try {
      const s = await makeSource(u.id);
      const now = new Date();
      // Three events in the last 30 minutes.
      await makeEvent(s.id, new Date(now.getTime() - 5 * 60_000));
      await makeEvent(s.id, new Date(now.getTime() - 10 * 60_000));
      await makeEvent(s.id, new Date(now.getTime() - 20 * 60_000));

      const rows = await getThroughput({ userId: u.id, since: "1h" });
      const total = rows.reduce((acc, r) => acc + r.count, 0);
      expect(total).toBe(3);
      // 1h window @ 1-min buckets = 60 rows, all present (zero-filled).
      expect(rows).toHaveLength(60);
    } finally {
      await prisma.user.delete({ where: { id: u.id } });
    }
  });

  it("scopes to a single source when sourceId is provided", async () => {
    const u = await makeUser();
    try {
      const a = await makeSource(u.id, "A");
      const b = await makeSource(u.id, "B");
      const now = new Date();
      await makeEvent(a.id, new Date(now.getTime() - 5 * 60_000));
      await makeEvent(b.id, new Date(now.getTime() - 5 * 60_000));

      const rowsA = await getThroughput({ userId: u.id, since: "1h", sourceId: a.id });
      const totalA = rowsA.reduce((acc, r) => acc + r.count, 0);
      expect(totalA).toBe(1);
    } finally {
      await prisma.user.delete({ where: { id: u.id } });
    }
  });

  it("ignores other users' events", async () => {
    const u1 = await makeUser();
    const u2 = await makeUser();
    try {
      const s = await makeSource(u1.id);
      await makeEvent(s.id, new Date());
      const rows = await getThroughput({ userId: u2.id, since: "1h" });
      const total = rows.reduce((acc, r) => acc + r.count, 0);
      expect(total).toBe(0);
    } finally {
      await prisma.user.delete({ where: { id: u1.id } });
      await prisma.user.delete({ where: { id: u2.id } });
    }
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
npm test -- queries
```

Expected: FAIL — `Cannot find module './queries'`.

- [ ] **Step 3: Implement `getThroughput`**

Create `src/lib/metrics/queries.ts`:

```typescript
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "../prisma";

import { granularityFor, windowStart, zeroFill } from "./buckets";
import type {
  BucketGranularity,
  MetricsQueryParams,
  SinceWindow,
} from "./types";

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
```

> **Note on `Prisma.raw`:** This is used only with allow-listed constants from `TRUNC_PRECISION` and integer literals derived from the typed `BucketSpec` — never user input. `userId`, `sourceId`, and `start` are all passed via `Prisma.sql` template parameters.

- [ ] **Step 4: Run the test**

```bash
npm test -- queries
```

Expected: PASS. The three throughput tests should be green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/metrics/queries.ts src/lib/metrics/queries.test.ts
git commit -m "feat(metrics): getThroughput aggregation query"
```

---

## Task 5: Success-rate query

**Files:**
- Modify: `src/lib/metrics/queries.ts`
- Modify: `src/lib/metrics/queries.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/lib/metrics/queries.test.ts` (and add a `makeDestination` + `makeDelivery` helper):

```typescript
import { DeliveryStatus } from "@/generated/prisma/enums";
import { getSuccessRate } from "./queries";

async function makeDestination(userId: string, name = "dest") {
  return prisma.destination.create({
    data: { userId, name, url: "https://example.test/" },
  });
}

async function makeDelivery(
  eventId: string,
  destinationId: string,
  status: DeliveryStatus,
) {
  return prisma.delivery.create({
    data: { eventId, destinationId, status, attemptCount: 1 },
  });
}

describe("getSuccessRate", () => {
  it("returns delivered and failed counts per bucket", async () => {
    const u = await makeUser();
    try {
      const s = await makeSource(u.id);
      const d = await makeDestination(u.id);
      const now = new Date();
      const e1 = await makeEvent(s.id, new Date(now.getTime() - 5 * 60_000));
      const e2 = await makeEvent(s.id, new Date(now.getTime() - 6 * 60_000));
      const e3 = await makeEvent(s.id, new Date(now.getTime() - 7 * 60_000));
      await makeDelivery(e1.id, d.id, "delivered");
      await makeDelivery(e2.id, d.id, "delivered");
      await makeDelivery(e3.id, d.id, "failed");

      const rows = await getSuccessRate({ userId: u.id, since: "1h" });
      const totalDelivered = rows.reduce((acc, r) => acc + r.delivered, 0);
      const totalFailed = rows.reduce((acc, r) => acc + r.failed, 0);
      expect(totalDelivered).toBe(2);
      expect(totalFailed).toBe(1);
    } finally {
      await prisma.user.delete({ where: { id: u.id } });
    }
  });

  it("counts exhausted as failed", async () => {
    const u = await makeUser();
    try {
      const s = await makeSource(u.id);
      const d = await makeDestination(u.id);
      const e = await makeEvent(s.id, new Date(Date.now() - 5 * 60_000));
      await makeDelivery(e.id, d.id, "exhausted");

      const rows = await getSuccessRate({ userId: u.id, since: "1h" });
      const totalFailed = rows.reduce((acc, r) => acc + r.failed, 0);
      expect(totalFailed).toBe(1);
    } finally {
      await prisma.user.delete({ where: { id: u.id } });
    }
  });

  it("excludes 'pending' and 'in_flight' deliveries (terminal-status only)", async () => {
    const u = await makeUser();
    try {
      const s = await makeSource(u.id);
      const d = await makeDestination(u.id);
      const e1 = await makeEvent(s.id, new Date(Date.now() - 5 * 60_000));
      const e2 = await makeEvent(s.id, new Date(Date.now() - 6 * 60_000));
      await makeDelivery(e1.id, d.id, "pending");
      await makeDelivery(e2.id, d.id, "in_flight");

      const rows = await getSuccessRate({ userId: u.id, since: "1h" });
      const total = rows.reduce((acc, r) => acc + r.delivered + r.failed, 0);
      expect(total).toBe(0);
    } finally {
      await prisma.user.delete({ where: { id: u.id } });
    }
  });
});
```

Run: `npm test -- queries`. Expected: FAIL — `getSuccessRate is not exported`.

- [ ] **Step 2: Implement `getSuccessRate`**

Append to `src/lib/metrics/queries.ts`:

```typescript
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
```

Run: `npm test -- queries`. Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/metrics/queries.ts src/lib/metrics/queries.test.ts
git commit -m "feat(metrics): getSuccessRate aggregation query"
```

---

## Task 6: Latency p50/p95 query

**Files:**
- Modify: `src/lib/metrics/queries.ts`
- Modify: `src/lib/metrics/queries.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/lib/metrics/queries.test.ts`:

```typescript
import { getLatency } from "./queries";

describe("getLatency", () => {
  it("returns p50/p95 in ms for delivered events", async () => {
    const u = await makeUser();
    try {
      const s = await makeSource(u.id);
      const d = await makeDestination(u.id);
      const now = new Date();
      const recv = new Date(now.getTime() - 5 * 60_000); // 5 minutes ago
      const e1 = await makeEvent(s.id, recv);
      const e2 = await makeEvent(s.id, recv);
      const e3 = await makeEvent(s.id, recv);
      // Latencies: 100ms, 200ms, 1000ms -> p50=200, p95~~960 (Postgres
      // percentile_cont interpolates; we just check approximate ordering).
      await prisma.delivery.createMany({
        data: [
          { eventId: e1.id, destinationId: d.id, status: "delivered", deliveredAt: new Date(recv.getTime() + 100) },
          { eventId: e2.id, destinationId: d.id, status: "delivered", deliveredAt: new Date(recv.getTime() + 200) },
          { eventId: e3.id, destinationId: d.id, status: "delivered", deliveredAt: new Date(recv.getTime() + 1000) },
        ],
      });

      const rows = await getLatency({ userId: u.id, since: "1h" });
      const withData = rows.filter((r) => r.p50 !== null);
      expect(withData).toHaveLength(1);
      expect(withData[0].p50).toBeGreaterThanOrEqual(100);
      expect(withData[0].p50).toBeLessThanOrEqual(300);
      expect(withData[0].p95).toBeGreaterThanOrEqual(withData[0].p50!);
      expect(withData[0].p95).toBeLessThanOrEqual(1000);
    } finally {
      await prisma.user.delete({ where: { id: u.id } });
    }
  });

  it("excludes deliveries that aren't 'delivered'", async () => {
    const u = await makeUser();
    try {
      const s = await makeSource(u.id);
      const d = await makeDestination(u.id);
      const e = await makeEvent(s.id, new Date(Date.now() - 5 * 60_000));
      await makeDelivery(e.id, d.id, "failed");

      const rows = await getLatency({ userId: u.id, since: "1h" });
      const withData = rows.filter((r) => r.p50 !== null);
      expect(withData).toHaveLength(0);
    } finally {
      await prisma.user.delete({ where: { id: u.id } });
    }
  });
});
```

Run: `npm test -- queries`. Expected: FAIL — `getLatency is not exported`.

- [ ] **Step 2: Implement `getLatency`**

Append to `src/lib/metrics/queries.ts`:

```typescript
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
```

Run: `npm test -- queries`. Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/metrics/queries.ts src/lib/metrics/queries.test.ts
git commit -m "feat(metrics): getLatency p50/p95 aggregation query"
```

---

## Task 7: Top failing destinations query

**Files:**
- Modify: `src/lib/metrics/queries.ts`
- Modify: `src/lib/metrics/queries.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/lib/metrics/queries.test.ts`:

```typescript
import { getTopFailing } from "./queries";

describe("getTopFailing", () => {
  it("ranks destinations by failed+exhausted count, descending", async () => {
    const u = await makeUser();
    try {
      const s = await makeSource(u.id);
      const da = await makeDestination(u.id, "A");
      const db = await makeDestination(u.id, "B");
      const e1 = await makeEvent(s.id, new Date(Date.now() - 5 * 60_000));
      const e2 = await makeEvent(s.id, new Date(Date.now() - 6 * 60_000));
      const e3 = await makeEvent(s.id, new Date(Date.now() - 7 * 60_000));

      await makeDelivery(e1.id, da.id, "failed");
      await makeDelivery(e2.id, da.id, "exhausted");
      await makeDelivery(e3.id, db.id, "failed");

      const rows = await getTopFailing({ userId: u.id, since: "1h" });
      expect(rows).toHaveLength(2);
      expect(rows[0].name).toBe("A");
      expect(rows[0].failures).toBe(2);
      expect(rows[1].name).toBe("B");
      expect(rows[1].failures).toBe(1);
    } finally {
      await prisma.user.delete({ where: { id: u.id } });
    }
  });

  it("returns an empty array when there are no failures", async () => {
    const u = await makeUser();
    try {
      const rows = await getTopFailing({ userId: u.id, since: "1h" });
      expect(rows).toEqual([]);
    } finally {
      await prisma.user.delete({ where: { id: u.id } });
    }
  });

  it("ignores other users' destinations", async () => {
    const u1 = await makeUser();
    const u2 = await makeUser();
    try {
      const s = await makeSource(u1.id);
      const d = await makeDestination(u1.id);
      const e = await makeEvent(s.id, new Date(Date.now() - 5 * 60_000));
      await makeDelivery(e.id, d.id, "failed");

      const rows = await getTopFailing({ userId: u2.id, since: "1h" });
      expect(rows).toEqual([]);
    } finally {
      await prisma.user.delete({ where: { id: u1.id } });
      await prisma.user.delete({ where: { id: u2.id } });
    }
  });
});
```

Run: `npm test -- queries`. Expected: FAIL — `getTopFailing is not exported`.

- [ ] **Step 2: Implement `getTopFailing`**

Append to `src/lib/metrics/queries.ts`:

```typescript
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
```

Run: `npm test -- queries`. Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/metrics/queries.ts src/lib/metrics/queries.test.ts
git commit -m "feat(metrics): getTopFailing destinations query"
```

---

## Task 8: KPI tile queries (totals)

**Files:**
- Modify: `src/lib/metrics/queries.ts`
- Modify: `src/lib/metrics/queries.test.ts`

One function returning all four KPI values in a single Postgres roundtrip — `Promise.all` would also work but a single query is slightly cheaper.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/metrics/queries.test.ts`:

```typescript
import { getOverviewTotals } from "./queries";

describe("getOverviewTotals", () => {
  it("computes total events, success rate, p95 latency, active sources", async () => {
    const u = await makeUser();
    try {
      const sA = await makeSource(u.id, "A");
      const sB = await makeSource(u.id, "B");
      const d = await makeDestination(u.id);
      const recv = new Date(Date.now() - 5 * 60_000);
      const e1 = await makeEvent(sA.id, recv);
      const e2 = await makeEvent(sA.id, recv);
      const e3 = await makeEvent(sB.id, recv);

      await prisma.delivery.createMany({
        data: [
          { eventId: e1.id, destinationId: d.id, status: "delivered", deliveredAt: new Date(recv.getTime() + 100) },
          { eventId: e2.id, destinationId: d.id, status: "delivered", deliveredAt: new Date(recv.getTime() + 200) },
          { eventId: e3.id, destinationId: d.id, status: "failed" },
        ],
      });

      const t = await getOverviewTotals({ userId: u.id, since: "1h" });
      expect(t.totalEvents).toBe(3);
      expect(t.activeSources).toBe(2);
      // 2 delivered / (2 delivered + 1 failed) = 66.66...%
      expect(t.successRate).toBeCloseTo(66.67, 1);
      expect(t.p95LatencyMs).toBeGreaterThanOrEqual(100);
      expect(t.p95LatencyMs).toBeLessThanOrEqual(300);
    } finally {
      await prisma.user.delete({ where: { id: u.id } });
    }
  });

  it("returns zeros / nulls when there is no data", async () => {
    const u = await makeUser();
    try {
      const t = await getOverviewTotals({ userId: u.id, since: "1h" });
      expect(t.totalEvents).toBe(0);
      expect(t.activeSources).toBe(0);
      expect(t.successRate).toBeNull();
      expect(t.p95LatencyMs).toBeNull();
    } finally {
      await prisma.user.delete({ where: { id: u.id } });
    }
  });
});
```

Run: `npm test -- queries`. Expected: FAIL — `getOverviewTotals is not exported`.

- [ ] **Step 2: Implement `getOverviewTotals`**

Append to `src/lib/metrics/queries.ts`:

```typescript
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

  const ev = eventTotals[0] ?? { events: 0n, sources: 0n };
  const dv = deliveryTotals[0] ?? { delivered: 0n, failed: 0n };
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
```

Run: `npm test -- queries`. Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/metrics/queries.ts src/lib/metrics/queries.test.ts
git commit -m "feat(metrics): getOverviewTotals KPI tile query"
```

---

## Task 9: ChartCard + StatCard shells

**Files:**
- Create: `src/components/metrics/chart-card.tsx`
- Create: `src/components/metrics/stat-card.tsx`

These are server components — no `"use client"`. Just card markup.

- [ ] **Step 1: Create `<ChartCard>`**

Create `src/components/metrics/chart-card.tsx`:

```tsx
export function ChartCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-4 sm:p-6 dark:border-zinc-700 dark:bg-zinc-900">
      <header className="mb-3">
        <h2 className="text-sm font-medium">{title}</h2>
        {subtitle ? (
          <p className="mt-0.5 text-xs text-zinc-500">{subtitle}</p>
        ) : null}
      </header>
      <div className="h-60">{children}</div>
    </section>
  );
}
```

- [ ] **Step 2: Create `<StatCard>`**

Create `src/components/metrics/stat-card.tsx`:

```tsx
export function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-700 dark:bg-zinc-900">
      <div className="text-xs uppercase tracking-wide text-zinc-500">
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {hint ? (
        <div className="mt-1 text-xs text-zinc-500">{hint}</div>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 3: Verify TypeScript and the build**

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/metrics/chart-card.tsx src/components/metrics/stat-card.tsx
git commit -m "feat(metrics): ChartCard and StatCard shells"
```

---

## Task 10: TimeWindowSelector

**Files:** Create `src/components/metrics/time-window-selector.tsx`

Server component — renders four `<Link>` pills, no client-side JS needed.

- [ ] **Step 1: Implement**

Create `src/components/metrics/time-window-selector.tsx`:

```tsx
import Link from "next/link";

import { DEFAULT_SINCE, type SinceWindow } from "@/lib/metrics/types";

const WINDOWS: { value: SinceWindow; label: string }[] = [
  { value: "1h", label: "1h" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
];

export function TimeWindowSelector({
  basePath,
  active,
  extraParams = {},
}: {
  basePath: string;
  active: SinceWindow;
  extraParams?: Record<string, string>;
}) {
  return (
    <nav
      aria-label="Time window"
      className="inline-flex gap-1 rounded-md border border-zinc-200 bg-white p-0.5 dark:border-zinc-700 dark:bg-zinc-900"
    >
      {WINDOWS.map((w) => {
        const isActive = w.value === active;
        const params = new URLSearchParams(extraParams);
        if (w.value !== DEFAULT_SINCE) params.set("since", w.value);
        const href = params.toString() ? `${basePath}?${params}` : basePath;
        return (
          <Link
            key={w.value}
            href={href}
            aria-current={isActive ? "page" : undefined}
            className={
              isActive
                ? "rounded px-3 py-1 text-xs font-medium text-zinc-900 dark:text-zinc-100"
                : "rounded px-3 py-1 text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
            }
            style={
              isActive
                ? { borderBottom: "2px solid var(--brand-blue-fg)" }
                : undefined
            }
          >
            {w.label}
          </Link>
        );
      })}
    </nav>
  );
}
```

- [ ] **Step 2: Build check**

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/metrics/time-window-selector.tsx
git commit -m "feat(metrics): TimeWindowSelector pill buttons"
```

---

## Task 11: RefreshButton

**Files:** Create `src/components/metrics/refresh-button.tsx`

- [ ] **Step 1: Implement**

Create `src/components/metrics/refresh-button.tsx`:

```tsx
"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

export function RefreshButton() {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      onClick={() => start(() => router.refresh())}
      className="rounded-md border border-zinc-200 bg-white px-3 py-1 text-xs text-zinc-600 hover:text-zinc-900 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
      disabled={pending}
    >
      {pending ? "Refreshing…" : "Refresh"}
    </button>
  );
}
```

- [ ] **Step 2: Build check**

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/metrics/refresh-button.tsx
git commit -m "feat(metrics): RefreshButton client component"
```

---

## Task 12: ThroughputChart

**Files:**
- Create: `src/components/metrics/format.ts` (shared formatters)
- Create: `src/components/metrics/throughput-chart.tsx`

- [ ] **Step 1: Create shared formatters module**

Create `src/components/metrics/format.ts`:

```ts
export function formatTimestamp(value: number | string): string {
  const d = typeof value === "number" ? new Date(value) : new Date(value);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
```

- [ ] **Step 2: Implement ThroughputChart**

Create `src/components/metrics/throughput-chart.tsx`:

```tsx
"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { ThroughputRow } from "@/lib/metrics/queries";

import { formatTimestamp } from "./format";

export function ThroughputChart({ data }: { data: ThroughputRow[] }) {
  if (data.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-zinc-500">
        No events in this window.
      </div>
    );
  }
  const chartData = data.map((r) => ({
    t: r.bucket.getTime(),
    count: r.count,
  }));
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id="throughputFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--chart-line)" stopOpacity={0.35} />
            <stop offset="100%" stopColor="var(--chart-line)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="3 3" />
        <XAxis
          dataKey="t"
          type="number"
          domain={["dataMin", "dataMax"]}
          scale="time"
          tickFormatter={formatTimestamp}
          stroke="var(--chart-grid)"
          tick={{ fontSize: 11, fill: "var(--fg-2)" }}
        />
        <YAxis
          stroke="var(--chart-grid)"
          tick={{ fontSize: 11, fill: "var(--fg-2)" }}
          allowDecimals={false}
        />
        <Tooltip
          labelFormatter={(v) => formatTimestamp(v as number)}
          contentStyle={{
            background: "var(--bg-elevated)",
            border: "1px solid var(--border-1)",
            fontSize: 12,
          }}
        />
        <Area
          type="monotone"
          dataKey="count"
          stroke="var(--chart-line)"
          fill="url(#throughputFill)"
          strokeWidth={2}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
```

- [ ] **Step 3: Build check**

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/metrics/format.ts src/components/metrics/throughput-chart.tsx
git commit -m "feat(metrics): ThroughputChart (Recharts AreaChart) + shared formatters"
```

---

## Task 13: SuccessRateChart

**Files:** Create `src/components/metrics/success-rate-chart.tsx`

- [ ] **Step 1: Implement**

Create `src/components/metrics/success-rate-chart.tsx`:

```tsx
"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { SuccessRateRow } from "@/lib/metrics/queries";

import { formatTimestamp } from "./format";

export function SuccessRateChart({ data }: { data: SuccessRateRow[] }) {
  const hasTerminal = data.some((r) => r.delivered + r.failed > 0);
  if (!hasTerminal) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-zinc-500">
        No completed deliveries in this window.
      </div>
    );
  }
  const chartData = data.map((r) => {
    const total = r.delivered + r.failed;
    return {
      t: r.bucket.getTime(),
      pct: total === 0 ? null : (r.delivered / total) * 100,
      delivered: r.delivered,
      failed: r.failed,
    };
  });
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="3 3" />
        <XAxis
          dataKey="t"
          type="number"
          domain={["dataMin", "dataMax"]}
          scale="time"
          tickFormatter={formatTimestamp}
          stroke="var(--chart-grid)"
          tick={{ fontSize: 11, fill: "var(--fg-2)" }}
        />
        <YAxis
          stroke="var(--chart-grid)"
          tick={{ fontSize: 11, fill: "var(--fg-2)" }}
          domain={[0, 100]}
          tickFormatter={(v) => `${v}%`}
        />
        <Tooltip
          labelFormatter={(v) => formatTimestamp(v as number)}
          formatter={(value, name) => {
            if (name === "pct") {
              return [value === null ? "—" : `${Number(value).toFixed(1)}%`, "Success rate"];
            }
            return [value, name];
          }}
          contentStyle={{
            background: "var(--bg-elevated)",
            border: "1px solid var(--border-1)",
            fontSize: 12,
          }}
        />
        <Line
          type="monotone"
          dataKey="pct"
          stroke="var(--chart-line)"
          strokeWidth={2}
          dot={false}
          connectNulls
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
```

- [ ] **Step 2: Build check**

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/metrics/success-rate-chart.tsx
git commit -m "feat(metrics): SuccessRateChart (Recharts LineChart)"
```

---

## Task 14: LatencyChart

**Files:** Create `src/components/metrics/latency-chart.tsx`

- [ ] **Step 1: Implement**

Create `src/components/metrics/latency-chart.tsx`:

```tsx
"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { LatencyRow } from "@/lib/metrics/queries";

import { formatTimestamp } from "./format";

export function LatencyChart({ data }: { data: LatencyRow[] }) {
  const hasData = data.some((r) => r.p50 !== null);
  if (!hasData) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-zinc-500">
        No delivered events in this window.
      </div>
    );
  }
  const chartData = data.map((r) => ({
    t: r.bucket.getTime(),
    p50: r.p50,
    p95: r.p95,
  }));
  const allValues = chartData
    .flatMap((r) => [r.p50, r.p95])
    .filter((v): v is number => v !== null);
  const max = allValues.length ? Math.max(...allValues) : 0;
  const min = allValues.length ? Math.min(...allValues.filter((v) => v > 0)) : 1;
  const useLog = max > min * 10;
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="3 3" />
        <XAxis
          dataKey="t"
          type="number"
          domain={["dataMin", "dataMax"]}
          scale="time"
          tickFormatter={formatTimestamp}
          stroke="var(--chart-grid)"
          tick={{ fontSize: 11, fill: "var(--fg-2)" }}
        />
        <YAxis
          stroke="var(--chart-grid)"
          tick={{ fontSize: 11, fill: "var(--fg-2)" }}
          scale={useLog ? "log" : "linear"}
          domain={useLog ? [1, "dataMax"] : [0, "dataMax"]}
          allowDataOverflow
          tickFormatter={(v) => (Number(v) >= 1000 ? `${(Number(v) / 1000).toFixed(1)}s` : `${v}ms`)}
        />
        <Tooltip
          labelFormatter={(v) => formatTimestamp(v as number)}
          formatter={(value, name) => {
            if (value === null) return ["—", name];
            const ms = Number(value);
            const display = ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms.toFixed(0)}ms`;
            return [display, name];
          }}
          contentStyle={{
            background: "var(--bg-elevated)",
            border: "1px solid var(--border-1)",
            fontSize: 12,
          }}
        />
        <Line
          type="monotone"
          dataKey="p50"
          stroke="var(--chart-line)"
          strokeWidth={2}
          dot={false}
          name="p50"
          connectNulls
        />
        <Line
          type="monotone"
          dataKey="p95"
          stroke="var(--chart-line)"
          strokeDasharray="4 3"
          strokeWidth={2}
          dot={false}
          name="p95"
          connectNulls
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
```

- [ ] **Step 2: Build check**

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/metrics/latency-chart.tsx
git commit -m "feat(metrics): LatencyChart with p50/p95 lines"
```

---

## Task 15: TopFailingTable

**Files:** Create `src/components/metrics/top-failing-table.tsx`

- [ ] **Step 1: Implement**

Create `src/components/metrics/top-failing-table.tsx`:

```tsx
import Link from "next/link";

import type { TopFailingRow } from "@/lib/metrics/queries";

function relativeTime(d: Date): string {
  const seconds = Math.floor((Date.now() - d.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

export function TopFailingTable({ rows }: { rows: TopFailingRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-zinc-500">
        No failures in this window.
      </div>
    );
  }
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-xs uppercase tracking-wide text-zinc-500">
          <th className="pb-2 font-medium">Destination</th>
          <th className="pb-2 text-right font-medium">Failures</th>
          <th className="pb-2 text-right font-medium">Last failure</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.destinationId} className="border-t border-zinc-100 dark:border-zinc-800">
            <td className="py-2">
              <Link
                href={`/destinations/${r.destinationId}`}
                className="text-zinc-900 hover:underline dark:text-zinc-100"
              >
                {r.name}
              </Link>
            </td>
            <td className="py-2 text-right tabular-nums">{r.failures}</td>
            <td className="py-2 text-right text-zinc-500 tabular-nums">{relativeTime(r.lastFailure)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

- [ ] **Step 2: Build check**

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/metrics/top-failing-table.tsx
git commit -m "feat(metrics): TopFailingTable component"
```

---

## Task 16: `/overview` page

**Files:**
- Create: `src/app/(dashboard)/overview/page.tsx`
- Create: `src/app/(dashboard)/overview/error.tsx`

- [ ] **Step 1: Create the error boundary**

Create `src/app/(dashboard)/overview/error.tsx`:

```tsx
"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";

export default function OverviewError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-700 dark:bg-zinc-900">
      <h2 className="text-sm font-medium">Couldn't load metrics</h2>
      <p className="mt-1 text-sm text-zinc-500">
        Something went wrong loading this page. The error has been reported.
      </p>
      <button
        type="button"
        onClick={reset}
        className="mt-3 rounded-md border border-zinc-200 bg-white px-3 py-1 text-xs text-zinc-700 hover:text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100"
      >
        Try again
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Create the page**

Create `src/app/(dashboard)/overview/page.tsx`:

```tsx
import { auth } from "@/auth";
import {
  getLatency,
  getOverviewTotals,
  getSuccessRate,
  getThroughput,
  getTopFailing,
} from "@/lib/metrics/queries";
import { DEFAULT_SINCE, SINCE_VALUES, type SinceWindow } from "@/lib/metrics/types";

import { ChartCard } from "@/components/metrics/chart-card";
import { LatencyChart } from "@/components/metrics/latency-chart";
import { RefreshButton } from "@/components/metrics/refresh-button";
import { StatCard } from "@/components/metrics/stat-card";
import { SuccessRateChart } from "@/components/metrics/success-rate-chart";
import { ThroughputChart } from "@/components/metrics/throughput-chart";
import { TimeWindowSelector } from "@/components/metrics/time-window-selector";
import { TopFailingTable } from "@/components/metrics/top-failing-table";

export const revalidate = 60;

function parseSince(value: string | undefined): SinceWindow {
  if (value && SINCE_VALUES.has(value as SinceWindow)) return value as SinceWindow;
  return DEFAULT_SINCE;
}

function fmtMs(ms: number | null): string {
  if (ms === null) return "—";
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${ms.toFixed(0)}ms`;
}

function fmtPct(pct: number | null): string {
  if (pct === null) return "—";
  return `${pct.toFixed(1)}%`;
}

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ since?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) return null;
  const { since: rawSince } = await searchParams;
  const since = parseSince(rawSince);
  const userId = session.user.id;

  const [totals, throughput, successRate, latency, topFailing] = await Promise.all([
    getOverviewTotals({ userId, since }),
    getThroughput({ userId, since }),
    getSuccessRate({ userId, since }),
    getLatency({ userId, since }),
    getTopFailing({ userId, since }),
  ]);

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Account-wide activity for the selected window.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <TimeWindowSelector basePath="/overview" active={since} />
          <RefreshButton />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total events" value={totals.totalEvents.toLocaleString()} />
        <StatCard label="Success rate" value={fmtPct(totals.successRate)} />
        <StatCard label="p95 latency" value={fmtMs(totals.p95LatencyMs)} />
        <StatCard label="Active sources" value={totals.activeSources.toLocaleString()} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard title="Throughput" subtitle="Events received over time">
          <ThroughputChart data={throughput} />
        </ChartCard>
        <ChartCard title="Success rate" subtitle="Delivered ÷ (delivered + failed)">
          <SuccessRateChart data={successRate} />
        </ChartCard>
        <ChartCard title="Delivery latency" subtitle="p50 (solid) / p95 (dashed)">
          <LatencyChart data={latency} />
        </ChartCard>
        <ChartCard title="Top failing destinations" subtitle="Highest failure counts in window">
          <TopFailingTable rows={topFailing} />
        </ChartCard>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Manually verify the page renders**

Start the dev stack and visit the new page:

```bash
docker compose up -d
npm run dev
```

Sign in at `http://localhost:3000/signin` (use MailHog at `http://localhost:8025`), then navigate to `http://localhost:3000/overview` directly. The page should render with empty-state messages (no data yet).

- [ ] **Step 4: Optionally seed some events to see the charts**

If `src/scripts/seed-events.ts` exists, run it to populate data:

```bash
npx tsx src/scripts/seed-events.ts
```

Refresh `/overview` and confirm at least one chart shows data.

- [ ] **Step 5: Switch time windows and confirm URL updates**

Click each pill (1h, 24h, 7d, 30d). The URL should update to `?since=...` and the data should refilter.

- [ ] **Step 6: Commit**

```bash
git add src/app/\(dashboard\)/overview
git commit -m "feat(metrics): /overview landing page with 4 widgets + KPIs"
```

---

## Task 17: `/sources/[id]` page

**Files:**
- Create: `src/app/(dashboard)/sources/[id]/page.tsx`
- Create: `src/app/(dashboard)/sources/[id]/error.tsx`
- Modify: `src/app/(dashboard)/sources/page.tsx` (linkify each row)

- [ ] **Step 1: Create the error boundary**

Create `src/app/(dashboard)/sources/[id]/error.tsx`:

```tsx
"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";

export default function SourceDetailError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-700 dark:bg-zinc-900">
      <h2 className="text-sm font-medium">Couldn't load this source</h2>
      <p className="mt-1 text-sm text-zinc-500">
        Something went wrong. The error has been reported.
      </p>
      <button
        type="button"
        onClick={reset}
        className="mt-3 rounded-md border border-zinc-200 bg-white px-3 py-1 text-xs text-zinc-700 hover:text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100"
      >
        Try again
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Create the detail page**

Create `src/app/(dashboard)/sources/[id]/page.tsx`:

```tsx
import Link from "next/link";
import { notFound } from "next/navigation";

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import {
  getLatency,
  getSuccessRate,
  getThroughput,
  getTopFailing,
} from "@/lib/metrics/queries";
import { DEFAULT_SINCE, SINCE_VALUES, type SinceWindow } from "@/lib/metrics/types";

import { ChartCard } from "@/components/metrics/chart-card";
import { LatencyChart } from "@/components/metrics/latency-chart";
import { RefreshButton } from "@/components/metrics/refresh-button";
import { SuccessRateChart } from "@/components/metrics/success-rate-chart";
import { ThroughputChart } from "@/components/metrics/throughput-chart";
import { TimeWindowSelector } from "@/components/metrics/time-window-selector";
import { TopFailingTable } from "@/components/metrics/top-failing-table";

export const revalidate = 60;

function parseSince(value: string | undefined): SinceWindow {
  if (value && SINCE_VALUES.has(value as SinceWindow)) return value as SinceWindow;
  return DEFAULT_SINCE;
}

export default async function SourceDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ since?: string }>;
}) {
  const { id } = await params;
  const { since: rawSince } = await searchParams;
  const since = parseSince(rawSince);
  const session = await auth();
  if (!session?.user?.id) return null;
  const userId = session.user.id;

  const source = await prisma.source.findFirst({
    where: { id, userId },
    select: { id: true, name: true, slug: true },
  });
  if (!source) notFound();

  const [throughput, successRate, latency, topFailing] = await Promise.all([
    getThroughput({ userId, since, sourceId: source.id }),
    getSuccessRate({ userId, since, sourceId: source.id }),
    getLatency({ userId, since, sourceId: source.id }),
    getTopFailing({ userId, since, sourceId: source.id }),
  ]);

  return (
    <div className="space-y-8">
      <div>
        <Link href="/sources" className="text-sm text-zinc-500 hover:underline">
          ← Sources
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{source.name}</h1>
        <p className="mt-1 font-mono text-xs text-zinc-500">/api/ingest/{source.slug}</p>
      </div>

      <div className="flex items-center justify-end gap-2">
        <TimeWindowSelector basePath={`/sources/${source.id}`} active={since} />
        <RefreshButton />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard title="Throughput" subtitle="Events received over time">
          <ThroughputChart data={throughput} />
        </ChartCard>
        <ChartCard title="Success rate" subtitle="Delivered ÷ (delivered + failed)">
          <SuccessRateChart data={successRate} />
        </ChartCard>
        <ChartCard title="Delivery latency" subtitle="p50 (solid) / p95 (dashed)">
          <LatencyChart data={latency} />
        </ChartCard>
        <ChartCard title="Top failing destinations" subtitle="For this source">
          <TopFailingTable rows={topFailing} />
        </ChartCard>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Linkify sources list rows**

Locate the row markup in `src/app/(dashboard)/sources/page.tsx`. Find the source-name cell (it's likely inside a `<td>` showing `{source.name}`) and wrap it in a `<Link href={`/sources/${source.id}`}>` — same pattern as `top-failing-table.tsx`.

Read the existing file first:

```bash
cat "src/app/(dashboard)/sources/page.tsx"
```

Then edit the source-name cell. For example, if it reads:

```tsx
<td className="px-4 py-3 font-medium">{source.name}</td>
```

Change to:

```tsx
<td className="px-4 py-3 font-medium">
  <Link
    href={`/sources/${source.id}`}
    className="text-zinc-900 hover:underline dark:text-zinc-100"
  >
    {source.name}
  </Link>
</td>
```

Ensure `import Link from "next/link";` is at the top of the file.

- [ ] **Step 4: Manually verify**

```bash
npm run dev
```

Visit `/sources`, click a source name → land on `/sources/[id]`. Switch windows, click Refresh. Confirm 404 path: try `/sources/nonexistent-id`.

- [ ] **Step 5: Build check**

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(dashboard)/sources"
git commit -m "feat(metrics): /sources/[id] detail page with charts"
```

---

## Task 18: Extend `/destinations/[id]`

**Files:**
- Modify: `src/app/(dashboard)/destinations/[id]/page.tsx`
- Create: `src/app/(dashboard)/destinations/[id]/error.tsx`

- [ ] **Step 1: Create the error boundary**

Create `src/app/(dashboard)/destinations/[id]/error.tsx`:

```tsx
"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";

export default function DestinationDetailError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-700 dark:bg-zinc-900">
      <h2 className="text-sm font-medium">Couldn't load this destination</h2>
      <p className="mt-1 text-sm text-zinc-500">
        Something went wrong. The error has been reported.
      </p>
      <button
        type="button"
        onClick={reset}
        className="mt-3 rounded-md border border-zinc-200 bg-white px-3 py-1 text-xs text-zinc-700 hover:text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100"
      >
        Try again
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Read the current destinations detail page**

```bash
cat "src/app/(dashboard)/destinations/[id]/page.tsx"
```

Identify:
- The `searchParams` parameter (may not exist yet — we need to add it).
- The existing page structure (header + alert-override form).

- [ ] **Step 3: Modify the page to include charts**

Edit `src/app/(dashboard)/destinations/[id]/page.tsx`. Add `searchParams` to props, add `since` parsing, add chart queries via `Promise.all`, and insert a charts section between the page header and the existing form.

Add `export const revalidate = 60;` near the top.

Add imports at the top:

```tsx
import {
  getLatency,
  getSuccessRate,
  getThroughput,
} from "@/lib/metrics/queries";
import { DEFAULT_SINCE, SINCE_VALUES, type SinceWindow } from "@/lib/metrics/types";

import { ChartCard } from "@/components/metrics/chart-card";
import { LatencyChart } from "@/components/metrics/latency-chart";
import { RefreshButton } from "@/components/metrics/refresh-button";
import { SuccessRateChart } from "@/components/metrics/success-rate-chart";
import { ThroughputChart } from "@/components/metrics/throughput-chart";
import { TimeWindowSelector } from "@/components/metrics/time-window-selector";
```

Change the function signature:

```tsx
export default async function DestinationDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ since?: string }>;
}) {
```

Add this near the top of the function, after `auth()`:

```tsx
const { since: rawSince } = await searchParams;
const since: SinceWindow =
  rawSince && SINCE_VALUES.has(rawSince as SinceWindow)
    ? (rawSince as SinceWindow)
    : DEFAULT_SINCE;

const [throughput, successRate, latency] = await Promise.all([
  getThroughput({ userId: session.user.id, since, destinationId: id }),
  getSuccessRate({ userId: session.user.id, since, destinationId: id }),
  getLatency({ userId: session.user.id, since, destinationId: id }),
]);
```

Insert the metrics section in the JSX, between the page header and the `<form>`:

```tsx
<section className="space-y-4">
  <div className="flex items-center justify-end gap-2">
    <TimeWindowSelector basePath={`/destinations/${dest.id}`} active={since} />
    <RefreshButton />
  </div>
  <div className="grid gap-4 lg:grid-cols-2">
    <ChartCard title="Throughput" subtitle="Events forwarded to this destination">
      <ThroughputChart data={throughput} />
    </ChartCard>
    <ChartCard title="Success rate" subtitle="Delivered ÷ (delivered + failed)">
      <SuccessRateChart data={successRate} />
    </ChartCard>
    <ChartCard title="Delivery latency" subtitle="p50 (solid) / p95 (dashed)">
      <LatencyChart data={latency} />
    </ChartCard>
  </div>
</section>
```

Also: remove the `max-w-3xl` constraint from the wrapping div so charts fill the page width — change `<div className="max-w-3xl space-y-8">` to `<div className="space-y-8">`. The alerts form will then need its own max-width wrapper if you want to preserve the narrow look:

```tsx
<form action={saveDestinationAlerts} className="max-w-3xl space-y-6">
```

- [ ] **Step 4: Verify visually**

```bash
npm run dev
```

Open a destination detail page. The header → time selector → 3 charts → alerts form should all render top-to-bottom.

- [ ] **Step 5: Build check**

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(dashboard)/destinations"
git commit -m "feat(metrics): add charts to /destinations/[id]"
```

---

## Task 19: Wire-up nav, layout, signin redirect

**Files:**
- Modify: `src/components/nav-links.tsx`
- Modify: `src/app/(dashboard)/layout.tsx`
- Modify: `src/app/signin/page.tsx`

- [ ] **Step 1: Prepend "Overview" to the nav**

Edit `src/components/nav-links.tsx`. The `NAV` array currently starts:

```tsx
const NAV = [
  { href: "/sources", label: "Sources" },
  { href: "/events", label: "Events" },
  ...
];
```

Change to:

```tsx
const NAV = [
  { href: "/overview", label: "Overview" },
  { href: "/sources", label: "Sources" },
  { href: "/events", label: "Events" },
  { href: "/destinations", label: "Destinations" },
  { href: "/routes", label: "Routes" },
  { href: "/settings/api-keys", label: "Settings" },
  { href: "/settings/alerts", label: "Alerts" },
];
```

The `startsWith` active-link match used in the file is fine because `/overview` doesn't share a prefix with anything else.

- [ ] **Step 2: Update the logo link target**

In `src/app/(dashboard)/layout.tsx`, change:

```tsx
<Link href="/sources" className="flex shrink-0 items-center gap-2">
```

To:

```tsx
<Link href="/overview" className="flex shrink-0 items-center gap-2">
```

- [ ] **Step 3: Update the default post-signin redirect**

In `src/app/signin/page.tsx` at line 58 (or wherever `redirectTo` is set), change:

```tsx
const redirectTo = callbackUrl ?? "/sources";
```

To:

```tsx
const redirectTo = callbackUrl ?? "/overview";
```

Run to confirm:

```bash
grep -n "redirectTo" src/app/signin/page.tsx
```

- [ ] **Step 4: Build check**

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 5: Manually verify**

```bash
npm run dev
```

Sign out, then sign in fresh — you should land on `/overview`. The Overview nav item should be the first link and highlighted when on `/overview`.

- [ ] **Step 6: Commit**

```bash
git add src/components/nav-links.tsx "src/app/(dashboard)/layout.tsx" src/app/signin/page.tsx
git commit -m "feat(metrics): make /overview the post-signin landing"
```

---

## Task 20: Final verification + PR

**Files:** none

- [ ] **Step 1: Run the full test suite**

```bash
npm test
```

Expected: all tests pass. If any DB-backed tests fail, ensure `docker compose up -d` is running and `.env` has `DATABASE_URL`.

- [ ] **Step 2: Full production build**

```bash
npm run build
```

Expected: PASS. No type errors, no missing imports.

- [ ] **Step 3: Light/dark mode visual smoke**

In `npm run dev`:
- `/overview` — toggle theme, check all 4 charts + 4 KPI tiles + time selector + refresh button render correctly in both modes.
- `/sources/[id]` — same.
- `/destinations/[id]` — same.
- Click each time-window pill on each page; confirm URL updates and data refilters.

- [ ] **Step 4: Empty-state smoke**

Create a brand-new user (sign out, sign in with a fresh email):
- `/overview` should show "No events in this window" in all four widgets and "—" for the KPI tiles.

- [ ] **Step 5: Performance smoke**

In your browser devtools Network tab, reload `/overview` with `?since=30d`. The HTML response should arrive in well under 1 second on local dev. If it's slower, run `EXPLAIN ANALYZE` on the four queries via `docker compose exec postgres psql ...` and consider adding the `Delivery(status, updatedAt DESC)` index mentioned in the spec.

- [ ] **Step 6: Push the branch and open a PR**

```bash
git push -u origin feat/metrics-dashboard
gh pr create --title "feat(metrics): /overview landing with charts and per-source/destination drilldowns" --body "$(cat <<'EOF'
## Summary
- New /overview page (post-signin landing) with throughput, success rate, p50/p95 latency, top failing destinations, plus 4 KPI tiles
- New /sources/[id] detail page with the same charts scoped to one source
- Extended /destinations/[id] with the same charts scoped to one destination
- Live SQL aggregation, no schema changes, Recharts for visuals, revalidate: 60

## Test plan
- [ ] /overview renders in light and dark mode
- [ ] /sources/[id] renders and switches windows
- [ ] /destinations/[id] charts render above the existing alerts form
- [ ] Empty-state messages show for a brand-new user
- [ ] Refresh button busts the cache and reloads
- [ ] All Vitest tests pass

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Done.

---

## Self-review (executor)

Before declaring complete:
- All commits are TDD pairs (failing test, then implementation) for query/util modules.
- No file has placeholders or "TODO" markers.
- `npm test` is green.
- `npm run build` succeeds.
- Manual smoke completed in light and dark mode.
- PR opened.
