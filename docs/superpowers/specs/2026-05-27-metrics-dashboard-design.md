# Metrics dashboard — design spec

**Date:** 2026-05-27
**Status:** Draft — pending review
**Maps to:** Tier 2 #7 in the competitor-gap plan (`~/.claude/plans/ok-as-you-can-concurrent-engelbart.md`).

## Motivation

Today Odyhook surfaces no trends. The events page is a paginated list; the sources, destinations, and routes pages show counts but no shapes. A user can't answer "is everything OK?" without scrolling tables. This adds a charts surface so trends — throughput, success rate, latency, top failing destinations — are visible at a glance, with drilldowns on individual sources and destinations.

This is the smallest change that closes the "no charts anywhere" gap competitors flag.

## Scope

In scope:
- New top-level `/overview` page that becomes the post-signin landing.
- New per-source detail page at `/sources/[id]`.
- Extension of the existing `/destinations/[id]` page with metrics widgets above the alert-override form.
- Four metric widgets: throughput over time, success rate %, p50/p95 delivery latency, top failing destinations.
- Time window selector (`1h | 24h | 7d | 30d`) matching the events page convention.
- Recharts as the charting library.

Out of scope (deliberately deferred):
- Auto-refresh / WebSocket live updates. Manual refresh via a button only.
- Aggregation tables / materialized views. All queries are live SQL.
- Per-route metrics breakdown. Routes are not a primary mental model for "where is it broken?"; can add later if needed.
- Custom date-range picker. The four quick-pick windows are enough for v1.
- Drilldown from a chart point into filtered events. Nice-to-have, not required for v1.
- Per-source/per-destination KPI tiles. Only `/overview` gets KPI tiles in v1; detail pages get charts only.

## Architecture

### Surfaces

| Route | Change | Contents |
|---|---|---|
| `/overview` | NEW (default landing) | KPI tiles + 4 charts/tables, account-wide aggregation |
| `/sources/[id]` | NEW page | 4 charts scoped to source + small recent-events feed + signature-failure counter |
| `/destinations/[id]` | EXTEND existing | 4 charts scoped to destination, rendered above the existing alert-override form |
| `/sources` | Linkified | Each row links to `/sources/[id]` |
| `(dashboard)/layout.tsx` | Logo link | Changes from `/sources` to `/overview` |
| `src/components/nav-links.tsx` | Add nav item | Prepend `{ href: "/overview", label: "Overview" }` |
| `src/app/signin/page.tsx:58` | Update default | `const redirectTo = callbackUrl ?? "/sources"` → `"/overview"` |

### File layout

```
src/app/(dashboard)/overview/page.tsx          ← new
src/app/(dashboard)/sources/[id]/page.tsx      ← new
src/app/(dashboard)/destinations/[id]/page.tsx ← extend
src/components/metrics/
  chart-card.tsx                               ← shared shell
  stat-card.tsx                                ← KPI tile (overview only)
  throughput-chart.tsx                         ← Recharts AreaChart
  success-rate-chart.tsx                       ← Recharts LineChart
  latency-chart.tsx                            ← Recharts LineChart, 2 lines
  top-failing-table.tsx                        ← plain HTML table
  time-window-selector.tsx                     ← server-rendered pill buttons
src/lib/metrics/queries.ts                     ← all aggregation SQL
src/lib/metrics/queries.test.ts                ← Vitest unit tests
```

Server components do the queries; chart components are `"use client"` because Recharts uses SVG + DOM. Server passes pre-aggregated, pre-zero-filled rows; client components are dumb renderers.

### Data flow

```
URL /overview?since=24h
   ↓
Server component awaits Promise.all([
  getThroughput({ userId, since }),
  getSuccessRate({ userId, since }),
  getLatency({ userId, since }),
  getTopFailing({ userId, since }),
])
   ↓
Each query returns a zero-filled, time-bucketed array
   ↓
Server passes arrays as props to "use client" chart components
   ↓
Recharts renders SVG; ResponsiveContainer handles width
```

Drilldown pages (`/sources/[id]`, `/destinations/[id]`) call the same query functions with an extra `sourceId` or `destinationId` filter.

## Queries

All queries live in `src/lib/metrics/queries.ts`, use `prisma.$queryRaw` with parameterized SQL (Prisma's `groupBy` doesn't expose `date_trunc`), and accept a `{ userId, since, sourceId?, destinationId? }` filter object.

### Bucket granularity

Derived from the `since` window so every chart lands at 60–170 data points:

| Window | Bucket | Points |
|---|---|---|
| `1h` | 1 minute | 60 |
| `24h` (default) | 15 minutes | 96 |
| `7d` | 1 hour | 168 |
| `30d` | 6 hours | 120 |

### Throughput

```sql
SELECT date_trunc(<bucket>, e."receivedAt") AS bucket, count(*) AS count
FROM "Event" e
JOIN "Source" s ON s.id = e."sourceId"
WHERE s."userId" = $1
  AND e."receivedAt" >= $2
  -- optional: AND e."sourceId" = $3
GROUP BY 1
ORDER BY 1
```

Returns `{ bucket: Date, count: number }[]`. Server zero-fills missing buckets before returning.

### Success rate

```sql
SELECT
  date_trunc(<bucket>, e."receivedAt") AS bucket,
  COUNT(*) FILTER (WHERE d.status = 'delivered') AS delivered,
  COUNT(*) FILTER (WHERE d.status IN ('failed','exhausted')) AS failed
FROM "Delivery" d
JOIN "Event" e ON e.id = d."eventId"
JOIN "Source" s ON s.id = e."sourceId"
WHERE s."userId" = $1
  AND e."receivedAt" >= $2
  -- optional: AND e."sourceId" = $3
  -- optional: AND d."destinationId" = $3
GROUP BY 1
ORDER BY 1
```

Returns `{ bucket, delivered, failed }[]`. Client computes `delivered / (delivered + failed)` per point; renders nothing (or 100%) for points with zero deliveries.

### Latency p50/p95

```sql
SELECT
  date_trunc(<bucket>, e."receivedAt") AS bucket,
  percentile_cont(0.5) WITHIN GROUP (
    ORDER BY EXTRACT(epoch FROM (d."deliveredAt" - e."receivedAt")) * 1000
  ) AS p50,
  percentile_cont(0.95) WITHIN GROUP (
    ORDER BY EXTRACT(epoch FROM (d."deliveredAt" - e."receivedAt")) * 1000
  ) AS p95
FROM "Delivery" d
JOIN "Event" e ON e.id = d."eventId"
JOIN "Source" s ON s.id = e."sourceId"
WHERE s."userId" = $1
  AND d.status = 'delivered'
  AND d."deliveredAt" IS NOT NULL
  AND e."receivedAt" >= $2
GROUP BY 1
ORDER BY 1
```

Returns `{ bucket, p50, p95 }[]` in ms. Y-axis on the client is log-scaled if `max > 10 * min`.

### Top failing destinations

```sql
SELECT
  d."destinationId",
  dest.name,
  COUNT(*) AS failures,
  MAX(d."updatedAt") AS "lastFailure"
FROM "Delivery" d
JOIN "Destination" dest ON dest.id = d."destinationId"
WHERE dest."userId" = $1
  AND d.status IN ('failed','exhausted')
  AND d."updatedAt" >= $2
GROUP BY 1, 2
ORDER BY failures DESC
LIMIT 10
```

Returns `{ destinationId, name, failures, lastFailure }[]`. Empty array → empty-state message.

### KPI tile queries (overview only)

The four `<StatCard>` tiles on `/overview` derive from separate small aggregates (you can't compute an overall p95 by averaging per-bucket p95s):

| Tile | Query shape |
|---|---|
| Total events | `SELECT COUNT(*) FROM "Event" e JOIN "Source" s WHERE s."userId"=$1 AND e."receivedAt">=$2` |
| Success rate % | `SELECT COUNT(*) FILTER (WHERE status='delivered') * 100.0 / NULLIF(COUNT(*),0) FROM "Delivery" d JOIN ... WHERE status IN ('delivered','failed','exhausted')` |
| p95 latency (ms) | `SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(epoch FROM (d."deliveredAt" - e."receivedAt"))*1000) FROM "Delivery" d JOIN "Event" e ... WHERE status='delivered'` |
| Active sources | `SELECT COUNT(DISTINCT "sourceId") FROM "Event" e JOIN "Source" s WHERE s."userId"=$1 AND e."receivedAt">=$2` |

Each is one-shot — no buckets — and runs in parallel with the four chart queries.

### Indexes

Existing Prisma indexes already cover the first three queries:
- `Event(sourceId, receivedAt)` — throughput, success rate, latency, total-events, active-sources
- `Delivery(destinationId, status)` — top failing scoped by destination

Optional addition for the top-failing query: `Delivery(status, updatedAt DESC)`. Add only if `EXPLAIN ANALYZE` on realistic data shows a seq scan; otherwise skip. An index addition is technically a Prisma migration, but no column changes.

## Components

### Shared shell — `<ChartCard>`

Card with rounded border + header + body slot. Matches the existing pattern in `(dashboard)/sources/page.tsx`:
`rounded-lg border border-zinc-200 bg-white p-4 sm:p-6 dark:border-zinc-700 dark:bg-zinc-900`.

Props: `title: string`, `subtitle?: string`, `height?: number` (default 240), `children`.

### KPI tile — `<StatCard>`

Used only on `/overview`. Four tiles across the top:
- Total events (in window)
- Success rate %
- p95 latency (ms)
- Active sources (sources with ≥1 event in window)

Each: small label + big number. No "vs prior window" delta in v1 — defer.

### Chart components

All `"use client"`, all take pre-shaped data as a prop, none fetch. Wrapped in `<ResponsiveContainer width="100%" height={240}>`.

| Component | Recharts type | Notes |
|---|---|---|
| `<ThroughputChart>` | `<AreaChart>` | Gradient fill, single series |
| `<SuccessRateChart>` | `<LineChart>` | Y-axis 0–100, tooltip shows delivered / total / % |
| `<LatencyChart>` | `<LineChart>` | Two lines (p50 solid, p95 dashed), Y log-scale if max > 10×min |
| `<TopFailingTable>` | (no chart) | Plain HTML table, destination name links to `/destinations/[id]` |

Empty state: each component checks if the array is empty and renders a neutral "No events in this window" placeholder.

### Time window selector — `<TimeWindowSelector>`

Server-rendered pill buttons (`1h | 24h | 7d | 30d`) that update the `?since=` query param via `<Link>`. Active pill borrows the active-nav-link style from `nav-links.tsx`:
`borderBottom: "2px solid var(--brand-blue-fg)"`.

### Refresh button

Small client component in the page header. Calls `router.refresh()` to bust the page cache on demand. Same pattern as `events/page.tsx` if it exists there; otherwise this is the new pattern.

### Theming

Add two CSS vars to `globals.css`:
- `--chart-grid` — light: `zinc-200`, dark: `zinc-800`
- `--chart-line` — defaults to `--brand-blue-fg`

Recharts components reference these via inline `stroke="var(--chart-grid)"`.

## Error handling

Server components await all queries via `Promise.all`. If any query throws, the whole page falls through to a Next 16 `error.tsx` boundary placed at `src/app/(dashboard)/overview/error.tsx` (and same for the source/destination detail pages). The error boundary:
- Renders a neutral "Couldn't load metrics — try again" message
- Calls `Sentry.captureException` (Sentry is already wired via `instrumentation.ts`)
- Provides a "Retry" button that calls the `reset()` prop

Individual per-chart graceful degradation (one query fails, others render) is out of scope in v1 — keeps the code simple. Add if it becomes an operational nuisance.

## Caching & freshness

Each page (`/overview`, `/sources/[id]`, `/destinations/[id]`) declares `export const revalidate = 60`. Next 16 caches the rendered HTML for 60 seconds across requests. Manual **Refresh** button calls `router.refresh()` to bust on demand.

No auto-polling. If a live tile is needed later, add a single `setInterval` client component — not now.

## Schema changes

**None.** All four queries use existing fields:

| Field | Where it lives | Notes |
|---|---|---|
| `Event.receivedAt` | existing | Throughput x-axis, success-rate x-axis, latency x-axis |
| `Delivery.status` | existing enum | Filter for delivered / failed / exhausted |
| `Delivery.deliveredAt` | existing | Latency = `deliveredAt - receivedAt` |
| `Delivery.updatedAt` | existing | Proxy for "last failure time" in top-failing query |
| `Destination.name` | existing | Top-failing leaderboard label |

`Delivery.updatedAt`-as-last-failed-time is slightly lossy — if a row gets touched for any other reason after status flipped, the timestamp moves. Currently the only writes after status transitions are the worker's retry-attempt updates, so the value is accurate. If it drifts, add a dedicated `Delivery.lastFailedAt` column in a follow-up; out of scope here.

## Testing

### Unit tests — `src/lib/metrics/queries.test.ts`

Use Vitest + the existing test Postgres setup. For each of the four query functions:
- Seed a known set of events + deliveries with controlled timestamps and statuses
- Assert the returned buckets match expectation, including zero-fill of empty buckets
- Cover three scopes: account-wide, by source, by destination
- Cover the empty case (no rows in window) → empty array (not error)
- Edge case: an event with no delivered Delivery (still pending) → counted in throughput, not in success/latency

### Manual verification

Run locally:
1. `docker compose up -d` (pg + redis + mailhog)
2. `npm run dev` and `npm run worker` in separate terminals
3. Sign in via MailHog at `localhost:8025`
4. Seed a few sources/destinations and send test webhooks via `curl`
5. Open `/overview`, eyeball each chart in light and dark mode, at `?since=1h` and `?since=30d`
6. Click into `/sources/[id]` and `/destinations/[id]` — confirm scoping works
7. Click Refresh — confirm cache busts

No Recharts/SVG snapshot tests in v1. Recharts is third-party; testing its SVG output is brittle.

## Risks & open questions

| Risk | Mitigation |
|---|---|
| Live SQL becomes slow at scale | Existing indexes cover most queries. Add `Delivery(status, updatedAt DESC)` if needed. If `/overview` ever takes >500ms, build the rollup-table approach (Approach B from brainstorming). |
| Recharts bundle bloat (~100KB min+gzip) | Acceptable for a dashboard route. Charts are client-only; not pulled into the homepage or signin route. |
| `revalidate: 60` makes the page feel stale | Manual Refresh button is the escape valve. If it's a real problem, drop revalidate to 15 — but each page load already takes ≥4 DB queries, so longer caching is the right default. |
| Bucket granularity mismatch (e.g., 24h with new events still arriving in the most recent bucket) | Acceptable — every dashboard has this. Last bucket may visually undershoot. Add a "partial bucket" note in tooltip if it surprises users. |

## Out-of-band cleanup

While editing `(dashboard)/layout.tsx` and `nav-links.tsx`, no other changes. Don't redesign the nav or refactor unrelated code.

## Verification before completion

- All Vitest tests pass: `npm test`
- Build succeeds: `npm run build`
- Manual checklist (above) executed in dev with at least one full chart having data
- Lighthouse-style smoke: `/overview` renders under 1s on local dev

## Implementation order (suggested)

1. Install Recharts + add CSS vars to `globals.css`
2. Build `src/lib/metrics/queries.ts` + unit tests (this is the load-bearing part — get it right first)
3. Build shared components: `<ChartCard>`, `<StatCard>`, `<TimeWindowSelector>`, refresh button
4. Build the four chart components
5. Build `/overview/page.tsx` end-to-end; verify in dev
6. Build `/sources/[id]/page.tsx`
7. Extend `/destinations/[id]/page.tsx`
8. Update nav + landing redirect
9. Run full manual checklist; fix anything off
