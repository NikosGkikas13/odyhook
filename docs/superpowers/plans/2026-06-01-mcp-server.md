# Odyhook MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose Odyhook's sources, destinations, routes, events, and deliveries as MCP tools over a remote HTTP endpoint at `/api/mcp`, authenticated by existing `ody_` API tokens, so an MCP client (e.g. Claude Code) can operate the webhook router in natural language.

**Architecture:** A thin, stateless Streamable-HTTP MCP endpoint (`src/app/api/mcp/route.ts`) authenticates with the existing `authenticateApiToken` + `checkApiRateLimit`, then dispatches JSON-RPC messages to a transport-agnostic core (`src/lib/mcp/`). All tool logic lives in a registry of `{ name, description, inputSchema (zod), handler }` entries whose handlers call the existing `userId`-scoped `src/lib/services/*` functions. Four small service additions back the new read filters, route-filter persistence, and BYOK filter compilation. Tool input schemas are advertised as JSON Schema via zod 4's native `z.toJSONSchema()`.

**Tech Stack:** Next.js 16 (App Router route handler, `runtime = "nodejs"`), TypeScript (strict), Prisma 7, Zod 4 (`z.toJSONSchema`), Vitest 4 (real Postgres test DB). Hand-rolled JSON-RPC (spec's Approach C) — chosen for the plan because the surface is small/stateless and fully specifiable without an external SDK; the official `@modelcontextprotocol/sdk` (Approach A) remains a drop-in alternative for the dispatch shell (see Appendix). No DB migration — all changes use existing columns.

**Reference spec:** `docs/superpowers/specs/2026-06-01-mcp-server-design.md`

---

## Prerequisites (read once before starting)

- Tests hit a **real Postgres + Redis** (the repo does not mock Prisma). Before running any test:
  ```bash
  docker compose up -d        # postgres + redis + mailhog
  npm run db:migrate          # ensure schema is applied
  ```
- Run a single test file with: `npx vitest run <path>` (e.g. `npx vitest run src/lib/services/deliveries.test.ts`).
- Run the whole suite with: `npm test`.
- Typecheck with: `npx tsc --noEmit`. Lint with: `npm run lint`.
- The test harness pattern (copy it): create a `User`, then unique `slug`/`email` via `Date.now()` + random; mint tokens with `generateToken()` from `@/lib/api/token` (returns `{ raw, hash, prefix }`); create the `ApiToken` row with `{ userId, name, tokenHash: hash, prefix }`.
- **No schema/migration changes** are required anywhere in this plan.

## File structure

| File | Responsibility | Created/Modified |
|---|---|---|
| `src/lib/services/events.ts` | add optional `sourceId`/`since`/`until` filters to `listEvents` | Modify |
| `src/lib/services/deliveries.ts` | new `listDeliveries(userId, filter, page)` joining Delivery→Event→Source | Create |
| `src/lib/services/routes.ts` | add `setRouteFilter` / `clearRouteFilter` | Modify |
| `src/lib/actions/filters.ts` | repoint `saveRule`/`deleteRule`/`previewRule` to the new service fns (DRY) | Modify |
| `src/lib/services/filters.ts` | new `compileFilterForSource(userId, sourceId, prompt)` | Create |
| `src/lib/mcp/tools.ts` | the 20-tool registry + input schemas (transport-agnostic) | Create |
| `src/lib/mcp/server.ts` | JSON-RPC `handleMessage`, `runTool`, error mapping, `listToolSchemas` | Create |
| `src/app/api/mcp/route.ts` | thin POST handler: auth + rate limit + dispatch | Create |
| test files alongside each | Vitest unit/route tests | Create |
| `README.md`, `infra/README.md` | document the connect command + endpoint | Modify |

---

## Task 1: Add filters to `listEvents`

**Files:**
- Modify: `src/lib/services/events.ts`
- Test: `src/lib/services/events.filters.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/services/events.filters.test.ts`:

```ts
import "dotenv/config";
import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/prisma";
import { listEvents } from "./events";

function uniq(p: string) {
  return `${p}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

describe("listEvents filters", () => {
  it("filters by sourceId", async () => {
    const user = await prisma.user.create({ data: { email: `${uniq("evf")}@test.local` } });
    const s1 = await prisma.source.create({ data: { userId: user.id, name: "a", slug: uniq("evf-a") } });
    const s2 = await prisma.source.create({ data: { userId: user.id, name: "b", slug: uniq("evf-b") } });
    await prisma.event.create({ data: { sourceId: s1.id, method: "POST", headersJson: {}, bodyRaw: "{}" } });
    await prisma.event.create({ data: { sourceId: s2.id, method: "POST", headersJson: {}, bodyRaw: "{}" } });

    const res = await listEvents(user.id, { limit: 25, cursor: null }, { sourceId: s1.id });
    expect(res.data.length).toBeGreaterThanOrEqual(1);
    expect(res.data.every((e) => e.sourceId === s1.id)).toBe(true);
  });

  it("filters by since/until time range", async () => {
    const user = await prisma.user.create({ data: { email: `${uniq("evt")}@test.local` } });
    const s = await prisma.source.create({ data: { userId: user.id, name: "s", slug: uniq("evt-s") } });
    const old = await prisma.event.create({ data: { sourceId: s.id, method: "POST", headersJson: {}, bodyRaw: "{}", receivedAt: new Date("2020-01-01T00:00:00Z") } });
    const recent = await prisma.event.create({ data: { sourceId: s.id, method: "POST", headersJson: {}, bodyRaw: "{}" } });

    const res = await listEvents(user.id, { limit: 25, cursor: null }, { sourceId: s.id, since: "2021-01-01T00:00:00Z" });
    const ids = res.data.map((e) => e.id);
    expect(ids).toContain(recent.id);
    expect(ids).not.toContain(old.id);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/services/events.filters.test.ts`
Expected: FAIL — `listEvents` currently takes only 2 args; the 3rd-arg filter is ignored, so the `sourceId`/time assertions fail (both sources/events returned).

- [ ] **Step 3: Implement the filter**

In `src/lib/services/events.ts`, add the Prisma import at the top (after the existing imports):

```ts
import { Prisma } from "@/generated/prisma/client";
```

Add an exported filter type near the other exported types:

```ts
export type EventFilter = { sourceId?: string; since?: string; until?: string };
```

Replace the existing `listEvents` function with:

```ts
export async function listEvents(
  userId: string,
  page: Page,
  filter: EventFilter = {},
): Promise<{ data: EventDTO[]; nextCursor: string | null }> {
  const where: Prisma.EventWhereInput = {
    source: { userId },
    ...(filter.sourceId ? { sourceId: filter.sourceId } : {}),
    ...(filter.since || filter.until
      ? {
          receivedAt: {
            ...(filter.since ? { gte: new Date(filter.since) } : {}),
            ...(filter.until ? { lte: new Date(filter.until) } : {}),
          },
        }
      : {}),
  };
  const rows = await prisma.event.findMany({
    where,
    orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
    take: page.limit,
    ...(page.cursor ? { cursor: { id: page.cursor }, skip: 1 } : {}),
  });
  const nextCursor = rows.length === page.limit ? rows[rows.length - 1].id : null;
  return { data: rows.map(toDTO), nextCursor };
}
```

(The new third parameter defaults to `{}`, so the existing caller in `src/app/api/v1/events/route.ts` keeps working unchanged.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/services/events.filters.test.ts`
Expected: PASS (2 passing).

- [ ] **Step 5: Commit**

```bash
git add src/lib/services/events.ts src/lib/services/events.filters.test.ts
git commit -m "feat(events): optional sourceId/since/until filters on listEvents"
```

---

## Task 2: New `listDeliveries` service

**Files:**
- Create: `src/lib/services/deliveries.ts`
- Test: `src/lib/services/deliveries.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/services/deliveries.test.ts`:

```ts
import "dotenv/config";
import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/prisma";
import { listDeliveries } from "./deliveries";

function uniq(p: string) {
  return `${p}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function setup() {
  const user = await prisma.user.create({ data: { email: `${uniq("del")}@test.local` } });
  const source = await prisma.source.create({ data: { userId: user.id, name: "s", slug: uniq("del-s"), verifyStyle: "stripe" } });
  const dest = await prisma.destination.create({ data: { userId: user.id, name: "d", url: "https://example.com/hook" } });
  const event = await prisma.event.create({ data: { sourceId: source.id, method: "POST", headersJson: {}, bodyRaw: "{}" } });
  return { user, source, dest, event };
}

describe("listDeliveries", () => {
  it("filters by source and status, scoped to the user", async () => {
    const { user, source, dest, event } = await setup();
    await prisma.delivery.create({ data: { eventId: event.id, destinationId: dest.id, status: "failed", attemptCount: 3 } });
    await prisma.delivery.create({ data: { eventId: event.id, destinationId: dest.id, status: "delivered", attemptCount: 1 } });

    const failed = await listDeliveries(
      user.id,
      { sourceId: source.id, status: ["failed", "exhausted"] },
      { limit: 25, cursor: null },
    );
    expect(failed.data).toHaveLength(1);
    expect(failed.data[0].status).toBe("failed");
    expect(failed.data[0].sourceId).toBe(source.id);
    expect(failed.data[0].destinationId).toBe(dest.id);
  });

  it("does not return another user's deliveries", async () => {
    const a = await setup();
    await prisma.delivery.create({ data: { eventId: a.event.id, destinationId: a.dest.id, status: "failed", attemptCount: 1 } });
    const b = await setup();
    const res = await listDeliveries(b.user.id, {}, { limit: 25, cursor: null });
    expect(res.data.every((d) => d.sourceId !== a.source.id)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/services/deliveries.test.ts`
Expected: FAIL — `Cannot find module './deliveries'`.

- [ ] **Step 3: Implement the service**

Create `src/lib/services/deliveries.ts`:

```ts
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import type { DeliveryStatus } from "@/generated/prisma/enums";
import type { Page } from "@/lib/api/respond";

export type DeliveryListItem = {
  id: string;
  eventId: string;
  sourceId: string;
  destinationId: string;
  status: string;
  attemptCount: number;
  responseCode: number | null;
  lastError: string | null;
  createdAt: string;
  deliveredAt: string | null;
};

export type DeliveryFilter = {
  sourceId?: string;
  destinationId?: string;
  status?: string[];
  since?: string;
  until?: string;
};

export async function listDeliveries(
  userId: string,
  filter: DeliveryFilter,
  page: Page,
): Promise<{ data: DeliveryListItem[]; nextCursor: string | null }> {
  const where: Prisma.DeliveryWhereInput = {
    event: {
      source: { userId },
      ...(filter.sourceId ? { sourceId: filter.sourceId } : {}),
    },
    ...(filter.destinationId ? { destinationId: filter.destinationId } : {}),
    ...(filter.status && filter.status.length
      ? { status: { in: filter.status as DeliveryStatus[] } }
      : {}),
    ...(filter.since || filter.until
      ? {
          createdAt: {
            ...(filter.since ? { gte: new Date(filter.since) } : {}),
            ...(filter.until ? { lte: new Date(filter.until) } : {}),
          },
        }
      : {}),
  };

  const rows = await prisma.delivery.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: page.limit,
    ...(page.cursor ? { cursor: { id: page.cursor }, skip: 1 } : {}),
    include: { event: { select: { sourceId: true } } },
  });

  const nextCursor = rows.length === page.limit ? rows[rows.length - 1].id : null;
  return {
    data: rows.map((d) => ({
      id: d.id,
      eventId: d.eventId,
      sourceId: d.event.sourceId,
      destinationId: d.destinationId,
      status: d.status,
      attemptCount: d.attemptCount,
      responseCode: d.responseCode,
      lastError: d.lastError,
      createdAt: d.createdAt.toISOString(),
      deliveredAt: d.deliveredAt ? d.deliveredAt.toISOString() : null,
    })),
    nextCursor,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/services/deliveries.test.ts`
Expected: PASS (2 passing).

- [ ] **Step 5: Commit**

```bash
git add src/lib/services/deliveries.ts src/lib/services/deliveries.test.ts
git commit -m "feat(deliveries): listDeliveries service with source/destination/status/time filters"
```

---

## Task 3: `setRouteFilter` / `clearRouteFilter`

**Files:**
- Modify: `src/lib/services/routes.ts`
- Test: `src/lib/services/routes.filter.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/services/routes.filter.test.ts`:

```ts
import "dotenv/config";
import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/prisma";
import { setRouteFilter, clearRouteFilter } from "./routes";

function uniq(p: string) {
  return `${p}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function setupRoute() {
  const user = await prisma.user.create({ data: { email: `${uniq("rf")}@test.local` } });
  const source = await prisma.source.create({ data: { userId: user.id, name: "s", slug: uniq("rf-s") } });
  const dest = await prisma.destination.create({ data: { userId: user.id, name: "d", url: "https://example.com/h" } });
  const route = await prisma.route.create({ data: { sourceId: source.id, destinationId: dest.id } });
  return { user, route };
}

describe("setRouteFilter / clearRouteFilter", () => {
  it("persists and clears a filter AST", async () => {
    const { user, route } = await setupRoute();

    expect(await setRouteFilter(user.id, route.id, { exists: "$.id" })).toBe(true);
    const afterSet = await prisma.route.findUnique({ where: { id: route.id } });
    expect(afterSet?.filterAst).toEqual({ exists: "$.id" });

    expect(await clearRouteFilter(user.id, route.id)).toBe(true);
    const afterClear = await prisma.route.findUnique({ where: { id: route.id } });
    expect(afterClear?.filterAst).toBeNull();
  });

  it("returns false for another user's route", async () => {
    const a = await setupRoute();
    const b = await prisma.user.create({ data: { email: `${uniq("rf2")}@test.local` } });
    expect(await setRouteFilter(b.id, a.route.id, { exists: "$.id" })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/services/routes.filter.test.ts`
Expected: FAIL — `setRouteFilter`/`clearRouteFilter` are not exported.

- [ ] **Step 3: Implement the functions**

In `src/lib/services/routes.ts`, add these imports at the top (after the existing `import { z } from "zod";` block):

```ts
import { Prisma } from "@/generated/prisma/client";
import { validateFilterAst, type FilterAst } from "@/lib/filters/evaluator";
```

Append these exported functions to the end of the file:

```ts
/** Persist (set or replace) a route's filter AST. Returns false if the route isn't the user's. */
export async function setRouteFilter(
  userId: string,
  routeId: string,
  ast: FilterAst,
  prompt?: string | null,
): Promise<boolean> {
  const validated = validateFilterAst(ast);
  const existing = await prisma.route.findFirst({
    where: { id: routeId, source: { userId } },
    select: { id: true },
  });
  if (!existing) return false;
  await prisma.route.update({
    where: { id: routeId },
    data: { filterAst: validated as unknown as object, filterPrompt: prompt ?? null },
  });
  return true;
}

/** Remove a route's filter. Returns false if the route isn't the user's. */
export async function clearRouteFilter(userId: string, routeId: string): Promise<boolean> {
  const existing = await prisma.route.findFirst({
    where: { id: routeId, source: { userId } },
    select: { id: true },
  });
  if (!existing) return false;
  await prisma.route.update({
    where: { id: routeId },
    data: { filterAst: Prisma.DbNull, filterPrompt: null },
  });
  return true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/services/routes.filter.test.ts`
Expected: PASS (2 passing).

- [ ] **Step 5: Commit**

```bash
git add src/lib/services/routes.ts src/lib/services/routes.filter.test.ts
git commit -m "feat(routes): setRouteFilter/clearRouteFilter service functions"
```

---

## Task 4: Refactor `saveRule`/`deleteRule` to use the new service fns (DRY)

**Files:**
- Modify: `src/lib/actions/filters.ts`

This removes the inline `prisma.route.update` persistence from the server actions so the UI and MCP share one path. No new test (these are `"use server"` actions covered by the Task 3 service tests + the regression suite).

- [ ] **Step 1: Update imports**

In `src/lib/actions/filters.ts`, change the import block so it pulls the new service fns and drops the now-unused `Prisma` import. Replace:

```ts
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { compileRule } from "@/lib/ai/rule-compiler";
import { validateFilterAst, type FilterAst } from "@/lib/filters/evaluator";
```

with:

```ts
import { prisma } from "@/lib/prisma";
import { compileRule } from "@/lib/ai/rule-compiler";
import { setRouteFilter, clearRouteFilter } from "@/lib/services/routes";
import { validateFilterAst, type FilterAst } from "@/lib/filters/evaluator";
```

- [ ] **Step 2: Repoint `saveRule` persistence**

In `saveRule`, replace this block:

```ts
  await prisma.route.update({
    where: { id: routeId },
    data: {
      filterAst: ast as unknown as object,
      filterPrompt: prompt || null,
    },
  });
```

with:

```ts
  const saved = await setRouteFilter(userId, routeId, ast, prompt || null);
  if (!saved) throw new Error("route not found");
```

- [ ] **Step 3: Repoint `deleteRule` persistence**

In `deleteRule`, replace this block:

```ts
  await prisma.route.update({
    where: { id: routeId },
    data: { filterAst: Prisma.DbNull, filterPrompt: null },
  });
```

with:

```ts
  await clearRouteFilter(userId, routeId);
```

- [ ] **Step 4: Typecheck + run the related suites**

Run: `npx tsc --noEmit`
Expected: no errors (confirms `Prisma` is no longer referenced and imports resolve).

Run: `npx vitest run src/lib/services/routes.filter.test.ts src/lib/services/routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/actions/filters.ts
git commit -m "refactor(filters): route filter persistence via shared service fns"
```

---

## Task 5: `compileFilterForSource` + repoint `previewRule`

**Files:**
- Create: `src/lib/services/filters.ts`
- Modify: `src/lib/actions/filters.ts`
- Test: `src/lib/services/filters.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/services/filters.test.ts`:

```ts
import "dotenv/config";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/ai/rule-compiler", () => ({
  compileRule: vi.fn(async () => ({
    ast: { exists: "$.id" },
    matchedCount: 2,
    totalCount: 3,
    sampleMatches: [],
  })),
}));

import { prisma } from "@/lib/prisma";
import { compileRule } from "@/lib/ai/rule-compiler";
import { compileFilterForSource } from "./filters";

function uniq(p: string) {
  return `${p}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function setup() {
  const user = await prisma.user.create({ data: { email: `${uniq("cf")}@test.local` } });
  const source = await prisma.source.create({ data: { userId: user.id, name: "s", slug: uniq("cf-s") } });
  await prisma.event.create({ data: { sourceId: source.id, method: "POST", headersJson: {}, bodyRaw: JSON.stringify({ id: "evt_1" }) } });
  return { user, source };
}

describe("compileFilterForSource", () => {
  beforeEach(() => vi.clearAllMocks());

  it("loads recent samples and returns the compiled preview", async () => {
    const { user, source } = await setup();
    const out = await compileFilterForSource(user.id, source.id, "events with an id");
    expect(out).toEqual({ ast: { exists: "$.id" }, matchedCount: 2, totalCount: 3 });
    expect(compileRule).toHaveBeenCalledWith(user.id, "events with an id", expect.any(Array));
  });

  it("throws not found for a source the user does not own", async () => {
    const a = await setup();
    const b = await setup();
    await expect(compileFilterForSource(b.user.id, a.source.id, "x")).rejects.toThrow(/not found/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/services/filters.test.ts`
Expected: FAIL — `Cannot find module './filters'`.

- [ ] **Step 3: Implement the service**

Create `src/lib/services/filters.ts`:

```ts
import { prisma } from "@/lib/prisma";
import { compileRule } from "@/lib/ai/rule-compiler";
import type { FilterAst } from "@/lib/filters/evaluator";

/**
 * Compile a plain-English routing rule into a filter AST, grounded on the
 * source's most recent events. Preview only — does not persist. Verifies the
 * source belongs to the caller. Uses the caller's BYOK Anthropic key via
 * compileRule(); throws if no key is configured.
 */
export async function compileFilterForSource(
  userId: string,
  sourceId: string,
  prompt: string,
): Promise<{ ast: FilterAst; matchedCount: number; totalCount: number }> {
  const source = await prisma.source.findFirst({
    where: { id: sourceId, userId },
    select: { id: true },
  });
  if (!source) throw new Error("source not found");

  const recent = await prisma.event.findMany({
    where: { sourceId },
    orderBy: { receivedAt: "desc" },
    take: 50,
    select: { bodyRaw: true },
  });
  const samples: unknown[] = recent.map((e) => {
    try {
      return JSON.parse(e.bodyRaw);
    } catch {
      return { raw: e.bodyRaw };
    }
  });

  const result = await compileRule(userId, prompt, samples);
  return { ast: result.ast, matchedCount: result.matchedCount, totalCount: result.totalCount };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/services/filters.test.ts`
Expected: PASS (2 passing).

- [ ] **Step 5: Repoint `previewRule` to delegate (DRY)**

In `src/lib/actions/filters.ts`, add the import:

```ts
import { compileFilterForSource } from "@/lib/services/filters";
```

Replace the body of `previewRule` (the part after `const route = await loadRoute(userId, routeId);`) so the whole function reads:

```ts
export async function previewRule(
  routeId: string,
  prompt: string,
): Promise<{
  ast: FilterAst;
  matchedCount: number;
  totalCount: number;
}> {
  const userId = await requireUserId();
  const route = await loadRoute(userId, routeId);
  return compileFilterForSource(userId, route.sourceId, prompt);
}
```

- [ ] **Step 6: Typecheck + run filter suites**

Run: `npx tsc --noEmit`
Expected: no errors. (If `prisma` is now unused in `actions/filters.ts`, remove the unused import to satisfy lint; `saveRule` still uses `prisma`? It no longer calls `prisma` directly after Tasks 4–5 — verify and remove the `import { prisma }` line if `npm run lint` flags it.)

Run: `npx vitest run src/lib/services/filters.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/services/filters.ts src/lib/services/filters.test.ts src/lib/actions/filters.ts
git commit -m "feat(filters): compileFilterForSource service; previewRule delegates to it"
```

---

## Task 6: MCP tool registry

**Files:**
- Create: `src/lib/mcp/tools.ts`
- Test: `src/lib/mcp/tools.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/mcp/tools.test.ts`:

```ts
import "dotenv/config";
import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/prisma";
import { findTool, tools } from "./tools";

function uniq(p: string) {
  return `${p}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function setupUserSource() {
  const user = await prisma.user.create({ data: { email: `${uniq("mcpt")}@test.local` } });
  const source = await prisma.source.create({ data: { userId: user.id, name: "s", slug: uniq("mcpt-s"), verifyStyle: "stripe" } });
  return { user, source };
}

describe("mcp tool registry", () => {
  it("exposes the expected core tools", () => {
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "list_sources", "get_source", "list_deliveries", "list_events",
        "create_route", "set_route_filter", "compile_filter", "pause_destination",
      ]),
    );
  });

  it("list_sources returns only the caller's sources", async () => {
    const { user, source } = await setupUserSource();
    const other = await setupUserSource();
    const res = (await findTool("list_sources")!.handler(user.id, { limit: 100 })) as { data: { id: string }[] };
    const ids = res.data.map((s) => s.id);
    expect(ids).toContain(source.id);
    expect(ids).not.toContain(other.source.id);
  });

  it("get_source throws not found for another user's source", async () => {
    const a = await setupUserSource();
    const b = await setupUserSource();
    await expect(findTool("get_source")!.handler(b.user.id, { id: a.source.id })).rejects.toThrow(/not found/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/mcp/tools.test.ts`
Expected: FAIL — `Cannot find module './tools'`.

- [ ] **Step 3: Implement the registry**

Create `src/lib/mcp/tools.ts`:

```ts
import { z } from "zod";

import {
  listSources, getSource, createSource, updateSource,
  sourceCreateSchema, sourceUpdateSchema,
} from "@/lib/services/sources";
import {
  listDestinations, getDestination, createDestination, updateDestination,
  destinationCreateSchema, destinationUpdateSchema,
} from "@/lib/services/destinations";
import {
  listRoutes, getRoute, createRoute, updateRoute,
  setRouteFilter, clearRouteFilter, routeCreateSchema,
} from "@/lib/services/routes";
import { listEvents, getEvent } from "@/lib/services/events";
import { listDeliveries } from "@/lib/services/deliveries";
import { compileFilterForSource } from "@/lib/services/filters";
import { validateFilterAst } from "@/lib/filters/evaluator";
import type { Page } from "@/lib/api/respond";

export type ToolDef<S extends z.ZodTypeAny = z.ZodTypeAny> = {
  name: string;
  description: string;
  inputSchema: S;
  handler: (userId: string, input: z.infer<S>) => Promise<unknown>;
};

function defineTool<S extends z.ZodTypeAny>(def: ToolDef<S>): ToolDef {
  return def as unknown as ToolDef;
}

function orNotFound<T>(x: T | null): T {
  if (x == null) throw new Error("not found");
  return x;
}

function toPage(input: { limit?: number; cursor?: string }): Page {
  return { limit: input.limit ?? 25, cursor: input.cursor ?? null };
}

function validateAstOrThrow(value: unknown) {
  try {
    return validateFilterAst(value);
  } catch (e) {
    throw new Error(`invalid filter AST: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const pageShape = {
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
};
const idSchema = z.object({ id: z.string().min(1) });
const DELIVERY_STATUSES = ["pending", "in_flight", "delivered", "failed", "exhausted"] as const;

export const tools: ToolDef[] = [
  // ---------- Reads ----------
  defineTool({
    name: "list_sources",
    description: "List the caller's webhook sources (id, name, slug, verifyStyle). To find Stripe sources, look for verifyStyle === 'stripe'.",
    inputSchema: z.object({ ...pageShape }),
    handler: (u, i) => listSources(u, toPage(i)),
  }),
  defineTool({
    name: "get_source",
    description: "Get one source by id.",
    inputSchema: idSchema,
    handler: async (u, i) => orNotFound(await getSource(u, i.id)),
  }),
  defineTool({
    name: "list_destinations",
    description: "List destinations (includes enabled, consecutiveFailures, autoDisabledAt).",
    inputSchema: z.object({ ...pageShape }),
    handler: (u, i) => listDestinations(u, toPage(i)),
  }),
  defineTool({
    name: "get_destination",
    description: "Get one destination by id.",
    inputSchema: idSchema,
    handler: async (u, i) => orNotFound(await getDestination(u, i.id)),
  }),
  defineTool({
    name: "list_routes",
    description: "List routes (source→destination links; hasFilter indicates a filter is attached).",
    inputSchema: z.object({ ...pageShape }),
    handler: (u, i) => listRoutes(u, toPage(i)),
  }),
  defineTool({
    name: "get_route",
    description: "Get one route by id.",
    inputSchema: idSchema,
    handler: async (u, i) => orNotFound(await getRoute(u, i.id)),
  }),
  defineTool({
    name: "list_events",
    description: "List received webhook events, newest first. Optional filters: sourceId, since/until (ISO 8601 timestamps).",
    inputSchema: z.object({
      sourceId: z.string().optional(),
      since: z.string().datetime().optional(),
      until: z.string().datetime().optional(),
      ...pageShape,
    }),
    handler: (u, i) => listEvents(u, toPage(i), { sourceId: i.sourceId, since: i.since, until: i.until }),
  }),
  defineTool({
    name: "get_event",
    description: "Get one event by id, including raw body, headers, and all delivery attempts.",
    inputSchema: idSchema,
    handler: async (u, i) => orNotFound(await getEvent(u, i.id)),
  }),
  defineTool({
    name: "list_deliveries",
    description: "List delivery attempts, newest first. Filters: sourceId, destinationId, status (any of pending|in_flight|delivered|failed|exhausted), since/until (ISO 8601). For failures pass status: ['failed','exhausted'].",
    inputSchema: z.object({
      sourceId: z.string().optional(),
      destinationId: z.string().optional(),
      status: z.array(z.enum(DELIVERY_STATUSES)).optional(),
      since: z.string().datetime().optional(),
      until: z.string().datetime().optional(),
      ...pageShape,
    }),
    handler: (u, i) =>
      listDeliveries(
        u,
        { sourceId: i.sourceId, destinationId: i.destinationId, status: i.status, since: i.since, until: i.until },
        toPage(i),
      ),
  }),

  // ---------- Safe writes ----------
  defineTool({
    name: "create_source",
    description: "Create a webhook source. verifyStyle is one of none|stripe|github|generic-sha256; a signingSecret is required unless verifyStyle is none.",
    inputSchema: sourceCreateSchema,
    handler: (u, i) => createSource(u, i),
  }),
  defineTool({
    name: "update_source",
    description: "Update a source by id.",
    inputSchema: sourceUpdateSchema.extend({ id: z.string().min(1) }),
    handler: async (u, i) => {
      const { id, ...rest } = i;
      return orNotFound(await updateSource(u, id, rest));
    },
  }),
  defineTool({
    name: "create_destination",
    description: "Create a destination. headers is a 'Key: Value' string, one per line. outboundSecret (>=16 chars) enables HMAC signing of deliveries.",
    inputSchema: destinationCreateSchema,
    handler: (u, i) => createDestination(u, i),
  }),
  defineTool({
    name: "update_destination",
    description: "Update a destination by id. Set enabled:false to pause, enabled:true to resume (resume clears auto-disable state).",
    inputSchema: destinationUpdateSchema.extend({ id: z.string().min(1) }),
    handler: async (u, i) => {
      const { id, ...rest } = i;
      return orNotFound(await updateDestination(u, id, rest));
    },
  }),
  defineTool({
    name: "pause_destination",
    description: "Pause a destination by id (stops new and in-flight deliveries).",
    inputSchema: idSchema,
    handler: async (u, i) => orNotFound(await updateDestination(u, i.id, { enabled: false })),
  }),
  defineTool({
    name: "resume_destination",
    description: "Resume a paused or auto-disabled destination by id (clears circuit-breaker state).",
    inputSchema: idSchema,
    handler: async (u, i) => orNotFound(await updateDestination(u, i.id, { enabled: true })),
  }),
  defineTool({
    name: "create_route",
    description: "Create a route from a source to a destination. Optionally attach a structured filter AST (author one from plain English with compile_filter, or pass your own).",
    inputSchema: routeCreateSchema.extend({ filter: z.unknown().optional() }),
    handler: async (u, i) => {
      const { filter, ...routeInput } = i;
      const route = await createRoute(u, routeInput);
      if (filter !== undefined) {
        const ast = validateAstOrThrow(filter);
        await setRouteFilter(u, route.id, ast);
        return { ...route, hasFilter: true };
      }
      return route;
    },
  }),
  defineTool({
    name: "update_route",
    description: "Enable or disable a route by id.",
    inputSchema: z.object({ id: z.string().min(1), enabled: z.boolean().optional() }),
    handler: async (u, i) => {
      const { id, ...rest } = i;
      return orNotFound(await updateRoute(u, id, rest));
    },
  }),
  defineTool({
    name: "set_route_filter",
    description: "Attach or replace a structured filter AST on a route. The route forwards an event only when the filter matches.",
    inputSchema: z.object({ routeId: z.string().min(1), ast: z.unknown() }),
    handler: async (u, i) => {
      const ast = validateAstOrThrow(i.ast);
      const ok = await setRouteFilter(u, i.routeId, ast);
      if (!ok) throw new Error("route not found");
      return { ok: true };
    },
  }),
  defineTool({
    name: "clear_route_filter",
    description: "Remove the filter from a route so all events forward.",
    inputSchema: z.object({ routeId: z.string().min(1) }),
    handler: async (u, i) => {
      const ok = await clearRouteFilter(u, i.routeId);
      if (!ok) throw new Error("route not found");
      return { ok: true };
    },
  }),

  // ---------- BYOK ----------
  defineTool({
    name: "compile_filter",
    description: "Compile a plain-English routing rule into a filter AST, grounded on the source's recent events. Preview only — does NOT persist. Returns { ast, matchedCount, totalCount }. Requires the user's Anthropic key (Settings → API Keys).",
    inputSchema: z.object({ sourceId: z.string().min(1), prompt: z.string().min(1) }),
    handler: (u, i) => compileFilterForSource(u, i.sourceId, i.prompt),
  }),
];

export function findTool(name: string): ToolDef | undefined {
  return tools.find((t) => t.name === name);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/mcp/tools.test.ts`
Expected: PASS (3 passing).

- [ ] **Step 5: Commit**

```bash
git add src/lib/mcp/tools.ts src/lib/mcp/tools.test.ts
git commit -m "feat(mcp): transport-agnostic tool registry over the service layer"
```

---

## Task 7: MCP JSON-RPC dispatch + error mapping

**Files:**
- Create: `src/lib/mcp/server.ts`
- Test: `src/lib/mcp/server.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/mcp/server.test.ts`:

```ts
import "dotenv/config";
import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/prisma";
import { handleMessage, PROTOCOL_VERSION } from "./server";

function uniq(p: string) {
  return `${p}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
async function newUser() {
  return prisma.user.create({ data: { email: `${uniq("mcps")}@test.local` } });
}

describe("mcp handleMessage", () => {
  it("responds to initialize with protocol + serverInfo", async () => {
    const u = await newUser();
    const res = await handleMessage(u.id, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(res?.result).toMatchObject({ protocolVersion: PROTOCOL_VERSION, serverInfo: { name: "odyhook" } });
  });

  it("returns null for the initialized notification", async () => {
    const u = await newUser();
    const res = await handleMessage(u.id, { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(res).toBeNull();
  });

  it("lists tools with JSON Schemas", async () => {
    const u = await newUser();
    const res = await handleMessage(u.id, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const list = res?.result as { tools: { name: string; inputSchema: { type?: string } }[] };
    const t = list.tools.find((x) => x.name === "get_source");
    expect(t?.inputSchema.type).toBe("object");
  });

  it("calls a tool and returns scoped text content", async () => {
    const u = await newUser();
    const source = await prisma.source.create({ data: { userId: u.id, name: "s", slug: uniq("mcps-s") } });
    const res = await handleMessage(u.id, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_sources", arguments: { limit: 100 } } });
    const result = res?.result as { content: { text: string }[] };
    expect(result.content[0].text).toContain(source.id);
  });

  it("maps unknown method to -32601", async () => {
    const u = await newUser();
    const res = await handleMessage(u.id, { jsonrpc: "2.0", id: 4, method: "tools/nope" });
    expect(res?.error?.code).toBe(-32601);
  });

  it("returns invalid-params (-32602) for bad tool arguments", async () => {
    const u = await newUser();
    const res = await handleMessage(u.id, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "get_source", arguments: {} } });
    expect(res?.error?.code).toBe(-32602);
  });

  it("returns an isError result for an unknown tool name", async () => {
    const u = await newUser();
    const res = await handleMessage(u.id, { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "delete_everything", arguments: {} } });
    const result = res?.result as { isError?: boolean };
    expect(result.isError).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/mcp/server.test.ts`
Expected: FAIL — `Cannot find module './server'`.

- [ ] **Step 3: Implement the dispatch**

Create `src/lib/mcp/server.ts`:

```ts
import { z } from "zod";

import { tools, findTool } from "./tools";
import { RouteConflictError } from "@/lib/services/routes";

export const PROTOCOL_VERSION = "2025-06-18";
export const SERVER_INFO = { name: "odyhook", version: "1.0.0" };

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: { name?: unknown; arguments?: unknown; protocolVersion?: string } & Record<string, unknown>;
};

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

class McpError extends Error {
  constructor(public code: number, message: string, public data?: unknown) {
    super(message);
  }
}

function toolText(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}
function toolError(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function mapDomainError(err: unknown): ToolResult {
  if (err instanceof RouteConflictError) return toolError(`conflict: ${err.message}`);
  if (err instanceof Error) {
    if (/not found/i.test(err.message)) return toolError(err.message);
    if (/^invalid filter AST/i.test(err.message)) return toolError(err.message);
    if (/^Destination URL rejected:/.test(err.message) || /^Invalid header/.test(err.message)) return toolError(err.message);
    if (/No Anthropic API key configured/i.test(err.message)) return toolError(err.message);
  }
  console.error("[mcp] tool error:", err); // Sentry auto-captures
  return toolError("internal error");
}

export function listToolSchemas() {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: z.toJSONSchema(t.inputSchema),
  }));
}

export async function runTool(userId: string, name: unknown, args: unknown): Promise<ToolResult> {
  if (typeof name !== "string") throw new McpError(-32602, "tools/call requires a string 'name'");
  const tool = findTool(name);
  if (!tool) return toolError(`unknown tool: ${name}`);

  let parsed: unknown;
  try {
    parsed = tool.inputSchema.parse(args ?? {});
  } catch (e) {
    if (e instanceof z.ZodError) throw new McpError(-32602, "invalid tool arguments", e.issues);
    throw e;
  }

  try {
    return toolText(await tool.handler(userId, parsed as never));
  } catch (e) {
    return mapDomainError(e);
  }
}

function ok(id: JsonRpcRequest["id"], result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, result };
}
function fail(id: JsonRpcRequest["id"], code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

/** Handle one JSON-RPC message. Returns null for notifications (no response body). */
export async function handleMessage(userId: string, msg: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  const { id, method, params } = msg ?? ({} as JsonRpcRequest);
  try {
    switch (method) {
      case "initialize":
        return ok(id, {
          protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
        });
      case "notifications/initialized":
        return null;
      case "ping":
        return ok(id, {});
      case "tools/list":
        return ok(id, { tools: listToolSchemas() });
      case "tools/call":
        return ok(id, await runTool(userId, params?.name, params?.arguments));
      default:
        return fail(id, -32601, `method not found: ${method}`);
    }
  } catch (e) {
    if (e instanceof McpError) return fail(id, e.code, e.message, e.data);
    console.error("[mcp] unhandled:", e);
    return fail(id, -32603, "internal error");
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/mcp/server.test.ts`
Expected: PASS (7 passing).

- [ ] **Step 5: Commit**

```bash
git add src/lib/mcp/server.ts src/lib/mcp/server.test.ts
git commit -m "feat(mcp): JSON-RPC handleMessage, tool dispatch, and error mapping"
```

---

## Task 8: The `/api/mcp` route handler

**Files:**
- Create: `src/app/api/mcp/route.ts`
- Test: `src/app/api/mcp/route.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/app/api/mcp/route.test.ts`:

```ts
import "dotenv/config";
import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/prisma";
import { generateToken } from "@/lib/api/token";
import { POST } from "./route";

function uniq(p: string) {
  return `${p}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function setup() {
  const user = await prisma.user.create({ data: { email: `${uniq("mcpr")}@test.local` } });
  const t = generateToken();
  await prisma.apiToken.create({ data: { userId: user.id, name: "t", tokenHash: t.hash, prefix: t.prefix } });
  const source = await prisma.source.create({ data: { userId: user.id, name: "s", slug: uniq("mcpr-s") } });
  return { raw: t.raw, user, source };
}

function rpc(raw: string | null, msg: unknown): Request {
  return new Request("https://x/api/mcp", {
    method: "POST",
    headers: { ...(raw ? { authorization: `Bearer ${raw}` } : {}), "content-type": "application/json" },
    body: JSON.stringify(msg),
  });
}

describe("/api/mcp", () => {
  it("401s without a token", async () => {
    const res = await POST(rpc(null, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
    expect(res.status).toBe(401);
  });

  it("initializes with a valid token", async () => {
    const { raw } = await setup();
    const res = await POST(rpc(raw, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.serverInfo.name).toBe("odyhook");
  });

  it("calls a tool scoped to the token's user", async () => {
    const { raw, source } = await setup();
    const res = await POST(rpc(raw, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_sources", arguments: { limit: 100 } } }));
    const body = await res.json();
    expect(body.result.content[0].text).toContain(source.id);
  });

  it("does not expose another user's source", async () => {
    const a = await setup();
    const b = await setup();
    const res = await POST(rpc(b.raw, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_source", arguments: { id: a.source.id } } }));
    const body = await res.json();
    expect(body.result.isError).toBe(true);
  });

  it("returns 202 for a notification", async () => {
    const { raw } = await setup();
    const res = await POST(rpc(raw, { jsonrpc: "2.0", method: "notifications/initialized" }));
    expect(res.status).toBe(202);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/api/mcp/route.test.ts`
Expected: FAIL — `Cannot find module './route'`.

- [ ] **Step 3: Implement the route handler**

Create `src/app/api/mcp/route.ts`:

```ts
import { authenticateApiToken } from "@/lib/api/authenticate";
import { checkApiRateLimit } from "@/lib/ratelimit";
import { handleMessage, type JsonRpcRequest, type JsonRpcResponse } from "@/lib/mcp/server";

export const runtime = "nodejs";

function json(payload: unknown, status: number, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...(extraHeaders ?? {}) },
  });
}

export async function POST(req: Request): Promise<Response> {
  const auth = await authenticateApiToken(req);
  if (!auth) return json({ error: "unauthorized" }, 401);

  try {
    const rl = await checkApiRateLimit(auth.tokenId);
    if (!rl.allowed) {
      return json({ error: "rate limited" }, 429, {
        "retry-after": String(Math.max(1, Math.ceil(rl.retryAfterMs / 1000))),
      });
    }
  } catch (err) {
    // Fail open on Redis errors, matching ingest/api behavior.
    console.error("[mcp] rate limiter error (failing open):", err);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, 400);
  }

  const messages = Array.isArray(body) ? body : [body];
  const responses: JsonRpcResponse[] = [];
  for (const m of messages) {
    const res = await handleMessage(auth.userId, m as JsonRpcRequest);
    if (res) responses.push(res);
  }

  if (responses.length === 0) return new Response(null, { status: 202 });
  return json(Array.isArray(body) ? responses : responses[0], 200);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/api/mcp/route.test.ts`
Expected: PASS (5 passing).

- [ ] **Step 5: Full typecheck, lint, and suite**

Run: `npx tsc --noEmit && npm run lint && npm test`
Expected: typecheck clean, lint clean, all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/mcp/route.ts src/app/api/mcp/route.test.ts
git commit -m "feat(mcp): /api/mcp Streamable-HTTP endpoint (auth + rate limit + dispatch)"
```

---

## Task 9: Live verification with Claude Code + docs

**Files:**
- Modify: `README.md`, `infra/README.md`

This task validates the protocol against a real MCP client and documents the connect flow. (This is the connectivity check the spec called a "spike" — it runs last because the hand-rolled handler is already unit-tested; if a live client reveals a protocol mismatch, the fix is localized to `server.ts`/`route.ts`, and the SDK fallback in the Appendix is available.)

- [ ] **Step 1: Bring up the stack**

```bash
docker compose up -d
npm run db:migrate
npm run dev      # terminal 1 — http://localhost:3000
npm run worker   # terminal 2
```

- [ ] **Step 2: Mint a token**

Sign in (magic link via MailHog at http://localhost:8025), go to Settings → API Tokens, create one, copy the `ody_…` value.

- [ ] **Step 3: Connect Claude Code**

```bash
claude mcp add --transport http odyhook http://localhost:3000/api/mcp \
  --header "Authorization: Bearer ody_REPLACE_ME"
```

Then in Claude Code, confirm the server lists tools (e.g. run `/mcp` or ask "what odyhook tools are available?"). Expected: the 20 tools appear.

- [ ] **Step 4: Exercise the two flagship flows**

In Claude Code:
- "Using odyhook, show me failed deliveries for my Stripe source." → expect it to call `list_sources` (find `verifyStyle: "stripe"`) then `list_deliveries` with `status: ['failed','exhausted']`.
- "Create a route from <source> to <destination> that filters for pushes to main." → expect `compile_filter` then `create_route` (with the returned `ast`).

Cross-check the dashboard at http://localhost:3000 that the route + filter were created. If anything fails to connect, capture the client error and the server logs (`npm run dev` output) — the most likely culprits are the `protocolVersion` string or response `content-type`; both are isolated to `src/lib/mcp/server.ts` / `src/app/api/mcp/route.ts`.

- [ ] **Step 5: Document the endpoint**

Append to `README.md` a short section (place it after the developer quickstart):

```markdown
## MCP server

Odyhook exposes its sources, destinations, routes, events, and deliveries as MCP
tools at `/api/mcp`, authenticated with an API token (Settings → API Tokens):

    claude mcp add --transport http odyhook https://odyhook.dev/api/mcp \
      --header "Authorization: Bearer ody_…"

Then ask your agent things like "show me failed deliveries for my Stripe source"
or "create a route from gh-prod to slack-alerts filtering for pushes to main".
Reads cover sources/destinations/routes/events/deliveries; safe writes cover
create/update + pause/resume + route filters. `compile_filter` turns plain
English into a filter AST and needs your Anthropic key. There are no destructive
(delete) tools.
```

In `infra/README.md`, add one bullet to the "Notable endpoints beyond the ingest path" list:

```markdown
- **`POST /api/mcp`** is the Model Context Protocol (Streamable HTTP) endpoint.
  It authenticates with an `ody_` API token and exposes the read + safe-write
  tool surface over the existing service layer (see `src/lib/mcp/`). Stateless;
  no session store.
```

- [ ] **Step 6: Commit**

```bash
git add README.md infra/README.md
git commit -m "docs(mcp): document the /api/mcp endpoint and connect flow"
```

---

## Appendix: Switching to the official SDK (spec Approach A)

If you prefer the maintained SDK over the hand-rolled dispatch, only the **shell** changes — `src/lib/mcp/tools.ts` (registry) and the service additions are reused verbatim. Sketch:

1. `npm i @modelcontextprotocol/sdk`.
2. Build an `McpServer`, registering each entry from `tools` with `server.registerTool(name, { description, inputSchema: <zodRawShape> }, handler)`. Note the SDK wants a Zod raw shape; expose `inputSchema` as the object shape (or pass `.shape`) rather than the wrapped `z.object`.
3. In `src/app/api/mcp/route.ts`, after the existing `authenticateApiToken` + `checkApiRateLimit` guard, hand the request to a `StreamableHTTPServerTransport` instance (stateless mode) and bridge Next's `Request`/`Response`.
4. Keep the same auth/rate-limit guard and the cross-user isolation tests from Task 8 — they're transport-independent.

Prefer this only if you hit a protocol-compatibility issue in Task 9 that's awkward to fix by hand; otherwise the hand-rolled path has no external dependency and is fully covered by Tasks 7–8.

---

## Self-review notes (completed by plan author)

- **Spec coverage:** transport/auth (Tasks 7–8), read tools incl. `list_deliveries` flagship (Tasks 1–2, 6), safe writes incl. pause/resume + route filters (Tasks 3–6), `compile_filter` BYOK (Tasks 5–6), error mapping mirroring `withApiAuth` (Task 7), `z.toJSONSchema` schema advertisement (Task 7), testing incl. cross-user isolation (Tasks 2,6,7,8), manual verification (Task 9). Deferred items (public-REST exposure, replay/cancel) are intentionally out of scope per the spec.
- **No schema migration** is needed — confirmed: `filterAst`/`filterPrompt` columns and the `Delivery`/`Event` models already exist.
- **Type consistency:** `setRouteFilter(userId, routeId, ast, prompt?)` and `clearRouteFilter(userId, routeId)` used identically in Tasks 3/4/6; `compileFilterForSource(userId, sourceId, prompt)` returns `{ ast, matchedCount, totalCount }` used in Tasks 5/6; `listDeliveries(userId, filter, page)` arg order consistent across Tasks 2/6; `handleMessage`/`runTool`/`listToolSchemas` signatures consistent across Tasks 7/8.
- **Backward compatibility:** `listEvents`' new third param defaults to `{}`, so the existing `/api/v1/events` caller is unaffected.
