# Natural-Language Event Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users search webhook events in plain English across both metadata (source, time, delivery status) and JSON payload content, on the dashboard, the REST API, and as an MCP tool.

**Architecture:** Claude compiles English into a validated, structured `EventQuery { metadata, payload: FilterAst|null }`. A shared engine runs the metadata part as a Prisma `WHERE` and evaluates the payload AST in-memory (because `Event.bodyRaw` is `text`, not JSONB), bounded by a scan cap with resumable cursor pagination. Three thin surfaces call one orchestrator.

**Tech Stack:** Next.js 16 (App Router), TypeScript strict, Prisma 7 (Postgres), Vitest 4, `@anthropic-ai/sdk` (BYOK), Zod.

**Spec:** `docs/superpowers/specs/2026-06-01-nl-event-search-design.md`

**Conventions for every task:**
- Run a single test file with `npx vitest run <path>`.
- Type-check non-tested files (pages, components, actions) with `npx tsc --noEmit`.
- Per `AGENTS.md`, this repo runs a **modified Next.js 16** — before writing the server action (Task 9), the page (Task 11), or the route handler (Task 12), skim the relevant guide under `node_modules/next/dist/docs/`.
- DB-backed tests need Postgres up (`docker compose up -d`) and use `import "dotenv/config"`.
- End every commit message with the trailer:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- Work happens on branch `feat/nl-event-search` (already created; the spec commit is its first commit).

---

## Task 1: Filter AST — `startsWith` / `endsWith` nodes

**Files:**
- Modify: `src/lib/filters/evaluator.ts`
- Modify: `src/lib/filters/evaluator.test.ts`
- Modify: `src/lib/ai/rule-compiler.ts` (grammar text only)

- [ ] **Step 1: Write failing tests** — append to `src/lib/filters/evaluator.test.ts`

Add these `it` blocks inside the existing `describe("evaluateFilter — leaf operators", …)` block:

```ts
  it("startsWith: case-insensitive prefix on strings", () => {
    expect(evaluateFilter({ startsWith: ["$.type", "CHARGE."] }, sample)).toBe(true);
    expect(evaluateFilter({ startsWith: ["$.type", "refund"] }, sample)).toBe(false);
  });

  it("endsWith: case-insensitive suffix on strings", () => {
    expect(
      evaluateFilter({ endsWith: ["$.data.object.customer.email", "@B.COM"] }, sample),
    ).toBe(true);
    expect(
      evaluateFilter({ endsWith: ["$.data.object.customer.email", "@gmail.com"] }, sample),
    ).toBe(false);
  });

  it("startsWith/endsWith: return false on non-strings (fail-closed)", () => {
    expect(evaluateFilter({ startsWith: ["$.data.object.amount", "12"] }, sample)).toBe(false);
    expect(evaluateFilter({ endsWith: ["$.data.object.amount", "00"] }, sample)).toBe(false);
  });
```

Add these inside the existing `describe("validateFilterAst", …)` block:

```ts
  it("accepts startsWith/endsWith with string literals", () => {
    expect(validateFilterAst({ startsWith: ["$.a", "x"] })).toBeTypeOf("object");
    expect(validateFilterAst({ endsWith: ["$.a", "y"] })).toBeTypeOf("object");
  });

  it("rejects non-string literals on startsWith/endsWith", () => {
    expect(() => validateFilterAst({ startsWith: ["$.a", 1] })).toThrow(/string/);
    expect(() => validateFilterAst({ endsWith: ["$.a", 1] })).toThrow(/string/);
  });
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run src/lib/filters/evaluator.test.ts`
Expected: FAIL — `startsWith`/`endsWith` unknown node → `evaluateFilter` returns false (assertion fails) and `validateFilterAst` throws `unknown filter node`.

- [ ] **Step 3: Extend the `FilterAst` type** in `src/lib/filters/evaluator.ts`

Add two members to the union (after the `contains` line):

```ts
  | { startsWith: [JsonPath, string] }
  | { endsWith: [JsonPath, string] }
```

Also update the doc comment block near the top to list the two new ops (after the `contains` line):

```ts
//   { startsWith: [ path, string ] } // case-insensitive prefix on strings
//   { endsWith:   [ path, string ] } // case-insensitive suffix on strings
```

- [ ] **Step 4: Add evaluator branches** in `evaluateFilter`, immediately after the `contains` branch:

```ts
  if ("startsWith" in ast) {
    const [p, needle] = ast.startsWith;
    const v = readPath(event, p);
    return typeof v === "string"
      ? v.toLowerCase().startsWith(needle.toLowerCase())
      : false;
  }
  if ("endsWith" in ast) {
    const [p, needle] = ast.endsWith;
    const v = readPath(event, p);
    return typeof v === "string"
      ? v.toLowerCase().endsWith(needle.toLowerCase())
      : false;
  }
```

- [ ] **Step 5: Add validator cases** in `validateFilterAst` — add `startsWith` and `endsWith` to the existing 2-element-array `case` group and to the string-literal check. Change:

```ts
    case "eq":
    case "neq":
    case "in":
    case "contains":
    case "gt":
```
to add the two cases:
```ts
    case "eq":
    case "neq":
    case "in":
    case "contains":
    case "startsWith":
    case "endsWith":
    case "gt":
```
and change the contains string-check:
```ts
      if (key === "contains" && typeof lit !== "string") {
        throw new Error(`contains value must be a string`);
      }
```
to also cover the new ops:
```ts
      if (
        (key === "contains" || key === "startsWith" || key === "endsWith") &&
        typeof lit !== "string"
      ) {
        throw new Error(`${key} value must be a string`);
      }
```

- [ ] **Step 6: Add the ops to the route-filter compiler grammar** in `src/lib/ai/rule-compiler.ts` `SYSTEM_PROMPT`, after the `{ "contains": … }` line:

```
  { "startsWith": ["$.path.to.field", "prefix"] }
  { "endsWith":   ["$.path.to.field", "suffix"] }
```

- [ ] **Step 7: Run tests, verify pass**

Run: `npx vitest run src/lib/filters/evaluator.test.ts`
Expected: PASS (all, including the new cases).

- [ ] **Step 8: Commit**

```bash
git add src/lib/filters/evaluator.ts src/lib/filters/evaluator.test.ts src/lib/ai/rule-compiler.ts
git commit -m "feat(filters): add startsWith/endsWith AST nodes

Case-insensitive, string-only (matching contains). Available to route
filters and to the upcoming NL event search compiler.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: `EventQuery` type + `validateEventQuery`

**Files:**
- Create: `src/lib/search/types.ts`
- Create: `src/lib/search/types.test.ts`

- [ ] **Step 1: Write failing test** — `src/lib/search/types.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { validateEventQuery } from "./types";

const base = {
  metadata: { sourceId: null, receivedAfter: null, receivedBefore: null, status: null },
  payload: null,
};

describe("validateEventQuery", () => {
  it("accepts a fully-null metadata query", () => {
    expect(validateEventQuery(base)).toEqual(base);
  });

  it("normalizes timestamps to ISO and keeps a valid payload", () => {
    const q = validateEventQuery({
      metadata: {
        sourceId: "src_1",
        receivedAfter: "2026-05-01T00:00:00.000Z",
        receivedBefore: "2026-06-01T00:00:00.000Z",
        status: ["failed", "exhausted"],
      },
      payload: { endsWith: ["$.email", "@gmail.com"] },
    });
    expect(q.metadata.receivedAfter).toBe("2026-05-01T00:00:00.000Z");
    expect(q.metadata.status).toEqual(["failed", "exhausted"]);
    expect(q.payload).toEqual({ endsWith: ["$.email", "@gmail.com"] });
  });

  it("normalizes an empty status array to null", () => {
    expect(validateEventQuery({ ...base, metadata: { ...base.metadata, status: [] } }).metadata.status).toBeNull();
  });

  it("throws on an unparseable date", () => {
    expect(() => validateEventQuery({ ...base, metadata: { ...base.metadata, receivedAfter: "not-a-date" } })).toThrow(/date/i);
  });

  it("throws on an unknown status value", () => {
    expect(() => validateEventQuery({ ...base, metadata: { ...base.metadata, status: ["nope"] } })).toThrow(/status/i);
  });

  it("throws on a malformed payload AST", () => {
    expect(() => validateEventQuery({ ...base, payload: { bogus: true } })).toThrow(/unknown filter node/i);
  });

  it("throws on a non-object input", () => {
    expect(() => validateEventQuery(null)).toThrow();
    expect(() => validateEventQuery(42)).toThrow();
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run src/lib/search/types.test.ts`
Expected: FAIL — `Cannot find module './types'`.

- [ ] **Step 3: Implement** `src/lib/search/types.ts`

```ts
import { validateFilterAst, type FilterAst } from "@/lib/filters/evaluator";

// Delivery statuses, mirrored as a runtime list (the generated Prisma enum is a
// type only at this layer). Keep in sync with prisma/schema.prisma DeliveryStatus.
export const DELIVERY_STATUSES = [
  "pending",
  "in_flight",
  "delivered",
  "failed",
  "exhausted",
] as const;
export type DeliveryStatusValue = (typeof DELIVERY_STATUSES)[number];

export type SourceRef = { id: string; name: string; slug: string };

export type EventQuery = {
  metadata: {
    sourceId: string | null;
    receivedAfter: string | null; // ISO 8601
    receivedBefore: string | null; // ISO 8601
    status: DeliveryStatusValue[] | null; // one or more; e.g. ["failed","exhausted"]
  };
  payload: FilterAst | null;
};

function normIso(label: string, v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") throw new Error(`${label} must be an ISO date string or null`);
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) throw new Error(`${label} is not a valid date: ${v}`);
  return new Date(ms).toISOString();
}

/** Validate untrusted input (Claude output or a URL param) into an EventQuery.
 *  Throws a descriptive Error on any mismatch. Does NOT check source ownership —
 *  that is enforced structurally by buildEventWhere (source: { userId }). */
export function validateEventQuery(input: unknown): EventQuery {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("query must be an object");
  }
  const o = input as Record<string, unknown>;
  const md = o.metadata;
  if (!md || typeof md !== "object" || Array.isArray(md)) {
    throw new Error("query.metadata must be an object");
  }
  const m = md as Record<string, unknown>;

  const sourceId = m.sourceId == null ? null : String(m.sourceId);

  let status: DeliveryStatusValue[] | null = null;
  if (m.status != null) {
    if (!Array.isArray(m.status)) throw new Error("status must be an array or null");
    const vals = m.status.map((s) => {
      if (typeof s !== "string" || !(DELIVERY_STATUSES as readonly string[]).includes(s)) {
        throw new Error(`unknown status value: ${String(s)}`);
      }
      return s as DeliveryStatusValue;
    });
    status = vals.length > 0 ? vals : null;
  }

  const payload = o.payload == null ? null : validateFilterAst(o.payload);

  return {
    metadata: {
      sourceId,
      receivedAfter: normIso("receivedAfter", m.receivedAfter),
      receivedBefore: normIso("receivedBefore", m.receivedBefore),
      status,
    },
    payload,
  };
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `npx vitest run src/lib/search/types.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/search/types.ts src/lib/search/types.test.ts
git commit -m "feat(search): EventQuery type and validator

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: URL codec for the compiled query

**Files:**
- Create: `src/lib/search/url.ts`
- Create: `src/lib/search/url.test.ts`

Used by the dashboard: the client encodes the validated query into the `?q=` param; the server page decodes + re-validates it (never trust the URL).

- [ ] **Step 1: Write failing test** — `src/lib/search/url.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { encodeEventQuery, decodeEventQuery } from "./url";
import type { EventQuery } from "./types";

const q: EventQuery = {
  metadata: { sourceId: "s1", receivedAfter: "2026-05-01T00:00:00.000Z", receivedBefore: null, status: ["failed"] },
  payload: { endsWith: ["$.email", "@gmail.com"] },
};

describe("event query URL codec", () => {
  it("round-trips encode → decode", () => {
    expect(decodeEventQuery(encodeEventQuery(q))).toEqual(q);
  });

  it("decode validates (throws on garbage)", () => {
    expect(() => decodeEventQuery("not json")).toThrow(/malformed/i);
    expect(() => decodeEventQuery(JSON.stringify({ metadata: { status: ["nope"] } }))).toThrow();
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run src/lib/search/url.test.ts`
Expected: FAIL — `Cannot find module './url'`.

- [ ] **Step 3: Implement** `src/lib/search/url.ts`

```ts
import { validateEventQuery, type EventQuery } from "./types";

// The query travels in the `q` search param as JSON. URLSearchParams handles
// percent-encoding when building the href; Next decodes it before the page reads
// searchParams, so decode only needs to JSON.parse + re-validate.

export function encodeEventQuery(query: EventQuery): string {
  return JSON.stringify(query);
}

export function decodeEventQuery(raw: string): EventQuery {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("malformed search query");
  }
  return validateEventQuery(parsed);
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `npx vitest run src/lib/search/url.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/search/url.ts src/lib/search/url.test.ts
git commit -m "feat(search): URL codec for the compiled query

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: `buildEventWhere` — shared metadata → Prisma WHERE

**Files:**
- Create: `src/lib/search/where.ts`
- Create: `src/lib/search/where.test.ts`

- [ ] **Step 1: Write failing test** — `src/lib/search/where.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { buildEventWhere } from "./where";

describe("buildEventWhere", () => {
  it("always scopes to the user", () => {
    const w = buildEventWhere("u1", { sourceId: null, receivedAfter: null, receivedBefore: null, status: null });
    expect(w).toEqual({ source: { userId: "u1" } });
  });

  it("maps sourceId, time range, and status", () => {
    const w = buildEventWhere("u1", {
      sourceId: "s1",
      receivedAfter: "2026-05-01T00:00:00.000Z",
      receivedBefore: "2026-06-01T00:00:00.000Z",
      status: ["failed", "exhausted"],
    });
    expect(w.source).toEqual({ userId: "u1" });
    expect(w.sourceId).toBe("s1");
    expect(w.receivedAt).toEqual({
      gte: new Date("2026-05-01T00:00:00.000Z"),
      lt: new Date("2026-06-01T00:00:00.000Z"),
    });
    expect(w.deliveries).toEqual({ some: { status: { in: ["failed", "exhausted"] } } });
  });

  it("omits receivedAt when no bounds are set", () => {
    const w = buildEventWhere("u1", { sourceId: null, receivedAfter: "2026-05-01T00:00:00.000Z", receivedBefore: null, status: null });
    expect(w.receivedAt).toEqual({ gte: new Date("2026-05-01T00:00:00.000Z") });
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run src/lib/search/where.test.ts`
Expected: FAIL — `Cannot find module './where'`.

- [ ] **Step 3: Implement** `src/lib/search/where.ts`

```ts
import { Prisma } from "@/generated/prisma/client";
import type { EventQuery } from "./types";

/** Build the Prisma WHERE for an event metadata query. Always scopes by owner. */
export function buildEventWhere(
  userId: string,
  md: EventQuery["metadata"],
): Prisma.EventWhereInput {
  const where: Prisma.EventWhereInput = { source: { userId } };
  if (md.sourceId) where.sourceId = md.sourceId;

  const gte = md.receivedAfter ? new Date(md.receivedAfter) : undefined;
  const lt = md.receivedBefore ? new Date(md.receivedBefore) : undefined;
  if (gte || lt) {
    where.receivedAt = { ...(gte ? { gte } : {}), ...(lt ? { lt } : {}) };
  }

  if (md.status && md.status.length > 0) {
    where.deliveries = { some: { status: { in: md.status } } };
  }
  return where;
}
```

> If `tsc` rejects `{ in: md.status }` (string-literal union vs. the generated
> `DeliveryStatus` enum), import the enum and cast: add
> `import { DeliveryStatus } from "@/generated/prisma/enums";` and use
> `{ in: md.status as DeliveryStatus[] }`. The existing `list_deliveries` path
> passes the same hand-written status list into Prisma, so a cast is the
> established escape hatch if needed.

- [ ] **Step 4: Run test, verify pass**

Run: `npx vitest run src/lib/search/where.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/search/where.ts src/lib/search/where.test.ts
git commit -m "feat(search): shared metadata→Prisma WHERE builder

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: `describeEventQuery` / `describeFilterAst` — human-readable chips

**Files:**
- Create: `src/lib/search/describe.ts`
- Create: `src/lib/search/describe.test.ts`

- [ ] **Step 1: Write failing test** — `src/lib/search/describe.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { describeEventQuery, describeFilterAst } from "./describe";
import type { EventQuery } from "./types";

describe("describeFilterAst", () => {
  it("renders leaf and boolean nodes", () => {
    expect(describeFilterAst({ endsWith: ["$.data.customer.email", "@gmail.com"] })).toMatch(/ends with "@gmail.com"/);
    expect(describeFilterAst({ and: [{ eq: ["$.type", "x"] }, { gt: ["$.n", 5] }] })).toMatch(/AND/);
    expect(describeFilterAst({ not: { eq: ["$.a", 1] } })).toMatch(/NOT/);
  });
});

describe("describeEventQuery", () => {
  it("builds chips for source, time, status, and payload", () => {
    const q: EventQuery = {
      metadata: {
        sourceId: "s1",
        receivedAfter: "2026-05-01T00:00:00.000Z",
        receivedBefore: "2026-06-01T00:00:00.000Z",
        status: ["failed", "exhausted"],
      },
      payload: { endsWith: ["$.email", "@gmail.com"] },
    };
    const chips = describeEventQuery(q, [{ id: "s1", name: "Stripe" }]);
    expect(chips.some((c) => /source: Stripe/.test(c))).toBe(true);
    expect(chips.some((c) => /failed/.test(c) && /exhausted/.test(c))).toBe(true);
    expect(chips.some((c) => /body:/.test(c) && /ends with/.test(c))).toBe(true);
    expect(chips.some((c) => /\d/.test(c))).toBe(true); // a date chip exists
  });

  it("returns an 'all events' chip when nothing is constrained", () => {
    const q: EventQuery = { metadata: { sourceId: null, receivedAfter: null, receivedBefore: null, status: null }, payload: null };
    expect(describeEventQuery(q, [])).toEqual(["all events"]);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run src/lib/search/describe.test.ts`
Expected: FAIL — `Cannot find module './describe'`.

- [ ] **Step 3: Implement** `src/lib/search/describe.ts`

```ts
import type { FilterAst } from "@/lib/filters/evaluator";
import type { EventQuery, SourceRef } from "./types";

function field(path: string): string {
  return path.replace(/^\$\.?/, "");
}
function lit(v: unknown): string {
  return typeof v === "string" ? `"${v}"` : String(v);
}

/** Render a filter AST as a compact human-readable string. */
export function describeFilterAst(ast: FilterAst): string {
  if ("and" in ast) return ast.and.map(describeFilterAst).join(" AND ");
  if ("or" in ast) return ast.or.map(describeFilterAst).join(" OR ");
  if ("not" in ast) return `NOT (${describeFilterAst(ast.not)})`;
  if ("eq" in ast) return `${field(ast.eq[0])} = ${lit(ast.eq[1])}`;
  if ("neq" in ast) return `${field(ast.neq[0])} ≠ ${lit(ast.neq[1])}`;
  if ("gt" in ast) return `${field(ast.gt[0])} > ${ast.gt[1]}`;
  if ("gte" in ast) return `${field(ast.gte[0])} ≥ ${ast.gte[1]}`;
  if ("lt" in ast) return `${field(ast.lt[0])} < ${ast.lt[1]}`;
  if ("lte" in ast) return `${field(ast.lte[0])} ≤ ${ast.lte[1]}`;
  if ("in" in ast) return `${field(ast.in[0])} in [${ast.in[1].map(lit).join(", ")}]`;
  if ("contains" in ast) return `${field(ast.contains[0])} contains ${lit(ast.contains[1])}`;
  if ("startsWith" in ast) return `${field(ast.startsWith[0])} starts with ${lit(ast.startsWith[1])}`;
  if ("endsWith" in ast) return `${field(ast.endsWith[0])} ends with ${lit(ast.endsWith[1])}`;
  if ("exists" in ast) return `${field(ast.exists)} exists`;
  return JSON.stringify(ast);
}

function fmtDate(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10); // YYYY-MM-DD
}

/** Build human-readable chips describing what the query will run. */
export function describeEventQuery(
  query: EventQuery,
  sources: Pick<SourceRef, "id" | "name">[],
): string[] {
  const chips: string[] = [];
  const { metadata: m, payload } = query;

  if (m.sourceId) {
    const name = sources.find((s) => s.id === m.sourceId)?.name ?? m.sourceId;
    chips.push(`source: ${name}`);
  }
  if (m.receivedAfter && m.receivedBefore) {
    chips.push(`${fmtDate(m.receivedAfter)} – ${fmtDate(m.receivedBefore)}`);
  } else if (m.receivedAfter) {
    chips.push(`since ${fmtDate(m.receivedAfter)}`);
  } else if (m.receivedBefore) {
    chips.push(`before ${fmtDate(m.receivedBefore)}`);
  }
  if (m.status && m.status.length > 0) {
    chips.push(m.status.join(" / "));
  }
  if (payload) {
    chips.push(`body: ${describeFilterAst(payload)}`);
  }

  return chips.length > 0 ? chips : ["all events"];
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `npx vitest run src/lib/search/describe.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/search/describe.ts src/lib/search/describe.test.ts
git commit -m "feat(search): human-readable query/AST descriptions

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: `compileSearchQuery` — pure, dependency-injected compiler

**Files:**
- Create: `src/lib/ai/search-compiler.ts`
- Create: `src/lib/ai/search-compiler.test.ts`

Mirrors `generateFixture` / `explainEventDiff`: the Anthropic client and grounding data are passed in, so it is unit-testable with a fake client and pulls in no DB.

- [ ] **Step 1: Write failing test** — `src/lib/ai/search-compiler.test.ts`

```ts
import { describe, it, expect } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { compileSearchQuery, SearchCompileError } from "./search-compiler";

function fakeClient(text: string) {
  const calls: Array<{ system?: unknown; messages: unknown }> = [];
  const client = {
    messages: {
      create: async (args: { system?: unknown; messages: unknown }) => {
        calls.push({ system: args.system, messages: args.messages });
        return { model: "m", content: [{ type: "text", text }] };
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

const sources = [{ id: "src_stripe", name: "Stripe", slug: "stripe" }];
const VALID = JSON.stringify({
  metadata: { sourceId: "src_stripe", receivedAfter: "2026-05-31T00:00:00.000Z", receivedBefore: "2026-06-01T00:00:00.000Z", status: ["failed"] },
  payload: { endsWith: ["$.data.object.customer.email", "@gmail.com"] },
});

describe("compileSearchQuery", () => {
  it("returns a validated query and summary chips", async () => {
    const { client } = fakeClient(VALID);
    const res = await compileSearchQuery({
      anthropic: client, prompt: "failed stripe events yesterday from gmail users",
      sources, sampleBodies: ['{"data":{"object":{"customer":{"email":"a@gmail.com"}}}}'],
      now: new Date("2026-06-01T12:00:00Z"),
    });
    expect(res.query.metadata.sourceId).toBe("src_stripe");
    expect(res.query.payload).toEqual({ endsWith: ["$.data.object.customer.email", "@gmail.com"] });
    expect(res.summary.some((c) => /source: Stripe/.test(c))).toBe(true);
  });

  it("parses fenced JSON", async () => {
    const { client } = fakeClient("```json\n" + VALID + "\n```");
    const res = await compileSearchQuery({ anthropic: client, prompt: "x", sources, sampleBodies: [] });
    expect(res.query.metadata.status).toEqual(["failed"]);
  });

  it("coerces a foreign/unknown sourceId to null", async () => {
    const { client } = fakeClient(JSON.stringify({
      metadata: { sourceId: "src_someone_else", receivedAfter: null, receivedBefore: null, status: null },
      payload: null,
    }));
    const res = await compileSearchQuery({ anthropic: client, prompt: "x", sources, sampleBodies: [] });
    expect(res.query.metadata.sourceId).toBeNull();
  });

  it("throws SearchCompileError on non-JSON output", async () => {
    const { client } = fakeClient("sorry, I can't do that");
    await expect(compileSearchQuery({ anthropic: client, prompt: "x", sources, sampleBodies: [] })).rejects.toThrow(SearchCompileError);
  });

  it("throws SearchCompileError on a structurally invalid query", async () => {
    const { client } = fakeClient(JSON.stringify({ metadata: { status: ["nope"] }, payload: null }));
    await expect(compileSearchQuery({ anthropic: client, prompt: "x", sources, sampleBodies: [] })).rejects.toThrow(SearchCompileError);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run src/lib/ai/search-compiler.test.ts`
Expected: FAIL — `Cannot find module './search-compiler'`.

- [ ] **Step 3: Implement** `src/lib/ai/search-compiler.ts`

```ts
import type Anthropic from "@anthropic-ai/sdk";

import { MODEL_DEFAULT } from "./models";
import { extractJsonText } from "./json";
import { validateEventQuery, type EventQuery, type SourceRef } from "@/lib/search/types";
import { describeEventQuery } from "@/lib/search/describe";

export class SearchCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchCompileError";
  }
}

const SYSTEM_PROMPT = `You translate a plain-English event-search request into a single JSON object that filters webhook events. Output ONLY the JSON — no prose, no markdown fences.

Shape:
{
  "metadata": {
    "sourceId": string | null,        // pick from the provided sources, or null for all
    "receivedAfter": string | null,   // ISO 8601 UTC, inclusive lower bound
    "receivedBefore": string | null,  // ISO 8601 UTC, exclusive upper bound
    "status": string[] | null         // any of: pending, in_flight, delivered, failed, exhausted
  },
  "payload": <filter AST> | null       // matches against the JSON request body
}

Time:
- Resolve every relative time expression to an absolute receivedAfter/receivedBefore range using the provided "now" and timezone. Output timestamps in UTC ("Z").
- "yesterday" = the previous calendar day [00:00, next 00:00). "last 24h"/"last day" = now-24h to null. "since Monday" = that day 00:00 to null. "in May" = that month's [1st, next 1st).

Status:
- "failed"/"failures" usually means ["failed","exhausted"]. "delivered"/"successful" = ["delivered"].

Payload filter AST grammar (matches fields inside the JSON body; paths are JSONPath-lite starting with "$."):
  { "and": [node, ...] } | { "or": [node, ...] } | { "not": node }
  { "eq": ["$.path", literal] } | { "neq": ["$.path", literal] }
  { "gt"|"gte"|"lt"|"lte": ["$.path", number] }
  { "in": ["$.path", [literal, ...]] }
  { "contains": ["$.path", "substring"] }
  { "startsWith": ["$.path", "prefix"] } | { "endsWith": ["$.path", "suffix"] }
  { "exists": "$.path" }
Rules:
- Use payload: null when the request only constrains source/time/status.
- Ground payload paths in the provided sample bodies; do not invent fields.
- The payload root must be a single node (commonly an "and").`;

export type CompileSearchArgs = {
  anthropic: Anthropic;
  prompt: string;
  sources: SourceRef[];
  sampleBodies: string[];
  now?: Date;
  timeZone?: string;
};

export async function compileSearchQuery(
  args: CompileSearchArgs,
): Promise<{ query: EventQuery; summary: string[] }> {
  const now = args.now ?? new Date();
  const timeZone = args.timeZone ?? "UTC";

  const userMessage = [
    `Now: ${now.toISOString()}`,
    `Timezone: ${timeZone}`,
    ``,
    `Sources (resolve a named source to its id):`,
    JSON.stringify(args.sources.map((s) => ({ id: s.id, name: s.name, slug: s.slug }))),
    ``,
    `Recent sample event bodies (for grounding payload paths):`,
    "```json",
    JSON.stringify(args.sampleBodies.slice(0, 20)).slice(0, 6000),
    "```",
    ``,
    `Request: ${args.prompt}`,
    ``,
    `Return ONLY the JSON object.`,
  ].join("\n");

  const response = await args.anthropic.messages.create({
    model: MODEL_DEFAULT,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new SearchCompileError("could not interpret the search: no text returned");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonText(textBlock.text));
  } catch {
    throw new SearchCompileError("could not interpret the search: model did not return JSON");
  }

  let query: EventQuery;
  try {
    query = validateEventQuery(parsed);
  } catch (e) {
    throw new SearchCompileError(
      `could not interpret the search: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // Never trust the model's source id — coerce anything not owned by the caller to null.
  if (query.metadata.sourceId && !args.sources.some((s) => s.id === query.metadata.sourceId)) {
    query = { ...query, metadata: { ...query.metadata, sourceId: null } };
  }

  return { query, summary: describeEventQuery(query, args.sources) };
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `npx vitest run src/lib/ai/search-compiler.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/search-compiler.ts src/lib/ai/search-compiler.test.ts
git commit -m "feat(search): BYOK NL→EventQuery compiler (pure, DI)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: `runEventSearch` — the execution engine

**Files:**
- Create: `src/lib/search/run.ts`
- Create: `src/lib/search/run.test.ts`

DB-backed. Fast path for metadata-only; scan-cap + in-memory AST eval for payload queries; resumable cursor pagination. `scanCap`/`scanBatch` are overridable for testing.

- [ ] **Step 1: Write failing test** — `src/lib/search/run.test.ts`

```ts
import "dotenv/config";
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { runEventSearch } from "./run";
import type { EventQuery } from "./types";

function uniq(p: string) {
  return `${p}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function seed() {
  const user = await prisma.user.create({ data: { email: `${uniq("run")}@test.local` } });
  const source = await prisma.source.create({ data: { userId: user.id, name: "Stripe", slug: uniq("run-s") } });
  const dest = await prisma.destination.create({ data: { userId: user.id, name: "d", url: "https://example.com/h" } });
  // 6 events: 3 gmail, 3 other; alternating, newest last-created.
  for (let i = 0; i < 6; i++) {
    const email = i % 2 === 0 ? `u${i}@gmail.com` : `u${i}@outlook.com`;
    const ev = await prisma.event.create({
      data: {
        sourceId: source.id, method: "POST", headersJson: {},
        bodyRaw: JSON.stringify({ data: { object: { customer: { email } } } }),
      },
    });
    await prisma.delivery.create({
      data: { eventId: ev.id, destinationId: dest.id, status: i === 0 ? "failed" : "delivered" },
    });
  }
  return { user, source };
}

const META_ALL = { sourceId: null, receivedAfter: null, receivedBefore: null, status: null };

describe("runEventSearch", () => {
  let userId = "";
  beforeAll(async () => { userId = (await seed()).user.id; });

  it("fast path: metadata-only paginates newest-first", async () => {
    const q: EventQuery = { metadata: META_ALL, payload: null };
    const page1 = await runEventSearch(userId, q, { limit: 4 });
    expect(page1.events).toHaveLength(4);
    expect(page1.scanCapped).toBe(false);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await runEventSearch(userId, q, { limit: 4, cursor: page1.nextCursor });
    expect(page2.events).toHaveLength(2);
    expect(page2.nextCursor).toBeNull();
    const ids = new Set([...page1.events, ...page2.events].map((e) => e.id));
    expect(ids.size).toBe(6);
  });

  it("payload path: returns only matching bodies", async () => {
    const q: EventQuery = { metadata: META_ALL, payload: { endsWith: ["$.data.object.customer.email", "@gmail.com"] } };
    const res = await runEventSearch(userId, q, { limit: 50 });
    expect(res.events).toHaveLength(3);
    expect(res.events.every((e) => e.bodyRaw.includes("@gmail.com"))).toBe(true);
  });

  it("payload path: resumes across pages without gaps or dupes", async () => {
    const q: EventQuery = { metadata: META_ALL, payload: { endsWith: ["$.data.object.customer.email", "@gmail.com"] } };
    const p1 = await runEventSearch(userId, q, { limit: 2 });
    expect(p1.events).toHaveLength(2);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await runEventSearch(userId, q, { limit: 2, cursor: p1.nextCursor });
    const ids = new Set([...p1.events, ...p2.events].map((e) => e.id));
    expect(ids.size).toBe(3);
  });

  it("payload path: scanCapped when the scan cap is hit before filling a page", async () => {
    const q: EventQuery = { metadata: META_ALL, payload: { eq: ["$.data.object.customer.email", "nobody@nowhere.dev"] } };
    const res = await runEventSearch(userId, q, { limit: 10, scanCap: 2, scanBatch: 2 });
    expect(res.events).toHaveLength(0);
    expect(res.scanned).toBe(2);
    expect(res.scanCapped).toBe(true);
    expect(res.nextCursor).not.toBeNull();
  });

  it("filters by delivery status", async () => {
    const q: EventQuery = { metadata: { ...META_ALL, status: ["failed"] }, payload: null };
    const res = await runEventSearch(userId, q, { limit: 50 });
    expect(res.events).toHaveLength(1);
  });

  it("excludes another user's events", async () => {
    const other = await seed();
    const otherSource = await prisma.source.findFirstOrThrow({ where: { userId: other.user.id } });
    const q: EventQuery = { metadata: META_ALL, payload: null };
    const res = await runEventSearch(userId, q, { limit: 50 });
    expect(res.events.some((e) => e.sourceId === otherSource.id)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run src/lib/search/run.test.ts`
Expected: FAIL — `Cannot find module './run'`.

- [ ] **Step 3: Implement** `src/lib/search/run.ts`

```ts
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
```

- [ ] **Step 4: Run test, verify pass**

Run: `npx vitest run src/lib/search/run.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/search/run.ts src/lib/search/run.test.ts
git commit -m "feat(search): execution engine with scan-cap pagination

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: Service orchestration — context, compile, search

**Files:**
- Create: `src/lib/services/search.ts`
- Create: `src/lib/services/search.test.ts`

Loads grounding data + the user's BYOK key, then delegates to the pure compiler + engine. `loadSearchContext` is unit-tested; the no-key path is tested; the happy path is covered by Tasks 6–7.

- [ ] **Step 1: Write failing test** — `src/lib/services/search.test.ts`

```ts
import "dotenv/config";
import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/prisma";
import { loadSearchContext, compileSearchForUser } from "./search";

function uniq(p: string) {
  return `${p}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

describe("loadSearchContext", () => {
  it("returns the user's sources and recent sample bodies", async () => {
    const user = await prisma.user.create({ data: { email: `${uniq("ctx")}@test.local` } });
    const source = await prisma.source.create({ data: { userId: user.id, name: "Stripe", slug: uniq("ctx-s") } });
    await prisma.event.create({ data: { sourceId: source.id, method: "POST", headersJson: {}, bodyRaw: '{"a":1}' } });

    const ctx = await loadSearchContext(user.id);
    expect(ctx.sources.map((s) => s.id)).toContain(source.id);
    expect(ctx.sampleBodies).toContain('{"a":1}');
  });

  it("does not leak another user's sources", async () => {
    const a = await prisma.user.create({ data: { email: `${uniq("ctxa")}@test.local` } });
    const b = await prisma.user.create({ data: { email: `${uniq("ctxb")}@test.local` } });
    const sb = await prisma.source.create({ data: { userId: b.id, name: "B", slug: uniq("ctxb-s") } });
    const ctx = await loadSearchContext(a.id);
    expect(ctx.sources.map((s) => s.id)).not.toContain(sb.id);
  });
});

describe("compileSearchForUser", () => {
  it("throws when the user has no Anthropic key", async () => {
    const user = await prisma.user.create({ data: { email: `${uniq("nokey")}@test.local` } });
    await expect(compileSearchForUser(user.id, "anything")).rejects.toThrow(/Anthropic API key/i);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run src/lib/services/search.test.ts`
Expected: FAIL — `Cannot find module './search'`.

- [ ] **Step 3: Implement** `src/lib/services/search.ts`

```ts
import { prisma } from "@/lib/prisma";
import { anthropicFor } from "@/lib/anthropic";
import { compileSearchQuery } from "@/lib/ai/search-compiler";
import { runEventSearch, type RunSearchResult } from "@/lib/search/run";
import type { EventQuery, SourceRef } from "@/lib/search/types";

const SAMPLE_BODIES = 20;

export type SearchContext = { sources: SourceRef[]; sampleBodies: string[] };

/** Load the data Claude needs to ground a search: the user's sources and a
 *  sample of their most recent event bodies (across all sources). */
export async function loadSearchContext(userId: string): Promise<SearchContext> {
  const [sources, recent] = await Promise.all([
    prisma.source.findMany({
      where: { userId },
      select: { id: true, name: true, slug: true },
      orderBy: { name: "asc" },
    }),
    prisma.event.findMany({
      where: { source: { userId } },
      orderBy: { receivedAt: "desc" },
      take: SAMPLE_BODIES,
      select: { bodyRaw: true },
    }),
  ]);
  return { sources, sampleBodies: recent.map((e) => e.bodyRaw) };
}

export type CompileOpts = { now?: Date; timeZone?: string };

/** Compile an NL prompt into a validated EventQuery using the user's BYOK key.
 *  Throws NoUserApiKeyError if unset, SearchCompileError on bad model output. */
export async function compileSearchForUser(
  userId: string,
  prompt: string,
  opts: CompileOpts = {},
): Promise<{ query: EventQuery; summary: string[] }> {
  const [anthropic, ctx] = await Promise.all([
    anthropicFor(userId),
    loadSearchContext(userId),
  ]);
  return compileSearchQuery({
    anthropic,
    prompt,
    sources: ctx.sources,
    sampleBodies: ctx.sampleBodies,
    now: opts.now,
    timeZone: opts.timeZone,
  });
}

export type SearchOpts = CompileOpts & { limit?: number; cursor?: string | null };

/** Compile + run in one call (REST API and MCP). */
export async function searchEvents(
  userId: string,
  prompt: string,
  opts: SearchOpts = {},
): Promise<{ query: EventQuery; summary: string[] } & RunSearchResult> {
  const { query, summary } = await compileSearchForUser(userId, prompt, {
    now: opts.now,
    timeZone: opts.timeZone,
  });
  const result = await runEventSearch(userId, query, { limit: opts.limit, cursor: opts.cursor });
  return { query, summary, ...result };
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `npx vitest run src/lib/services/search.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/services/search.ts src/lib/services/search.test.ts
git commit -m "feat(search): service orchestration (context, compile, search)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: Dashboard server action `previewSearch`

**Files:**
- Create: `src/lib/actions/search.ts`

> Before writing: skim `node_modules/next/dist/docs/` for the Next 16 server-action conventions (`"use server"`, calling actions from client components).

Returns a discriminated result so the client can show key/interpretation errors inline instead of throwing an opaque server-action error.

- [ ] **Step 1: Implement** `src/lib/actions/search.ts`

```ts
"use server";

import { auth } from "@/auth";
import { NoUserApiKeyError } from "@/lib/anthropic";
import { compileSearchForUser } from "@/lib/services/search";
import { SearchCompileError } from "@/lib/ai/search-compiler";
import type { EventQuery } from "@/lib/search/types";

export type PreviewResult =
  | { ok: true; query: EventQuery; summary: string[] }
  | { ok: false; error: string };

async function requireUserId(): Promise<string> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("unauthorized");
  return session.user.id;
}

/** Compile an NL search to a query + chips (preview only — does not run it). */
export async function previewSearch(prompt: string, timeZone: string): Promise<PreviewResult> {
  const trimmed = prompt.trim();
  if (!trimmed) return { ok: false, error: "Enter a search to compile." };

  const userId = await requireUserId();
  try {
    const { query, summary } = await compileSearchForUser(userId, trimmed, { timeZone });
    return { ok: true, query, summary };
  } catch (e) {
    if (e instanceof NoUserApiKeyError) {
      return { ok: false, error: "No Anthropic API key configured. Set one in Settings → API Keys." };
    }
    if (e instanceof SearchCompileError) {
      return { ok: false, error: "Couldn't interpret that search. Try rephrasing." };
    }
    throw e; // unexpected → surfaces as a 500
  }
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/actions/search.ts
git commit -m "feat(search): previewSearch server action

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 10: Dashboard `EventsSearch` client component

**Files:**
- Create: `src/components/events-search.tsx`

Two-step: type → Compile (calls `previewSearch`) → confirm chips → Run (encodes query into `?q=` and navigates). "Edit" returns to the input.

- [ ] **Step 1: Implement** `src/components/events-search.tsx`

```tsx
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { previewSearch } from "@/lib/actions/search";
import { encodeEventQuery } from "@/lib/search/url";
import type { EventQuery } from "@/lib/search/types";

export function EventsSearch({ initialText = "" }: { initialText?: string }) {
  const router = useRouter();
  const [text, setText] = useState(initialText);
  const [pending, startTransition] = useTransition();
  const [compiling, setCompiling] = useState(false);
  const [preview, setPreview] = useState<{ query: EventQuery; summary: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onCompile(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPreview(null);
    setCompiling(true);
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      const res = await previewSearch(text, tz);
      if (res.ok) setPreview({ query: res.query, summary: res.summary });
      else setError(res.error);
    } finally {
      setCompiling(false);
    }
  }

  function onRun() {
    if (!preview) return;
    const sp = new URLSearchParams();
    sp.set("q", encodeEventQuery(preview.query));
    if (text.trim()) sp.set("qtext", text.trim());
    startTransition(() => router.push(`/events?${sp.toString()}`));
  }

  return (
    <div className="space-y-2">
      <form onSubmit={onCompile} className="flex gap-2">
        <input
          type="text"
          value={text}
          onChange={(e) => { setText(e.target.value); setPreview(null); }}
          placeholder='Search in English, e.g. "failed stripe events yesterday from gmail users"'
          aria-label="Search events in natural language"
          className="flex-1 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
        <button
          type="submit"
          disabled={compiling || !text.trim()}
          className="btn-primary-ody inline-flex h-9 items-center rounded-md px-3 text-sm font-medium disabled:opacity-60"
        >
          {compiling ? "Compiling…" : "Compile"}
        </button>
      </form>

      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>
      )}

      {preview && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm dark:border-indigo-900 dark:bg-indigo-950">
          <span className="text-zinc-600 dark:text-zinc-300">Interpreted as:</span>
          {preview.summary.map((chip, i) => (
            <span key={i} className="rounded bg-white px-2 py-0.5 text-xs font-medium text-indigo-900 dark:bg-zinc-900 dark:text-indigo-100">
              {chip}
            </span>
          ))}
          <div className="flex-1" />
          <button
            type="button"
            onClick={onRun}
            disabled={pending}
            className="btn-primary-ody inline-flex h-8 items-center rounded-md px-3 text-xs font-medium disabled:opacity-60"
          >
            {pending ? "Running…" : "Run search"}
          </button>
          <button
            type="button"
            onClick={() => setPreview(null)}
            className="text-xs text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
          >
            Edit
          </button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/events-search.tsx
git commit -m "feat(search): EventsSearch dashboard component

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 11: Events page — refactor onto `buildEventWhere` + search mode

**Files:**
- Modify: `src/app/(dashboard)/events/page.tsx`

> Before writing: skim `node_modules/next/dist/docs/` for Next 16 `searchParams` handling in server components.

When `?q=` is present, decode + run the search and render results with interpretation chips; otherwise keep today's filter-bar behavior (now built via `buildEventWhere`). The `EventsSearch` box renders in both modes.

- [ ] **Step 1: Replace the file** with the full version below

```tsx
import Link from "next/link";

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { EventsBulkActions } from "@/components/events-bulk-actions";
import { EventsFilter } from "@/components/events-filter";
import { EventsSearch } from "@/components/events-search";
import { buildEventWhere } from "@/lib/search/where";
import { runEventSearch } from "@/lib/search/run";
import { describeEventQuery } from "@/lib/search/describe";
import { decodeEventQuery } from "@/lib/search/url";
import { DeliveryStatus } from "@/generated/prisma/enums";
import type { DeliveryStatusValue } from "@/lib/search/types";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

const SINCE_MS: Record<string, number> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

const STATUS_VALUES = new Set<DeliveryStatus>([
  "delivered",
  "pending",
  "failed",
  "exhausted",
]);

type Search = {
  sourceId?: string;
  status?: string;
  since?: string;
  cursor?: string;
  q?: string;
  qtext?: string;
};

function buildQueryString(params: Record<string, string | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v) sp.set(k, v);
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export default async function EventsPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const session = await auth();
  if (!session?.user?.id) return null;
  const userId = session.user.id;

  const { sourceId, status, since, cursor, q, qtext } = await searchParams;

  const sources = await prisma.source.findMany({
    where: { userId },
    orderBy: { name: "asc" },
  });

  // ---- Search mode (?q=) -------------------------------------------------
  if (q) {
    let decoded;
    try {
      decoded = decodeEventQuery(q);
    } catch {
      return (
        <div className="space-y-6">
          <Header title="Events" subtitle="Couldn't read that search query." />
          <EventsSearch initialText={qtext ?? ""} />
          <Link href="/events" className="text-sm text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100">
            ← Clear search
          </Link>
        </div>
      );
    }

    const result = await runEventSearch(userId, decoded, { limit: PAGE_SIZE, cursor });
    const chips = describeEventQuery(decoded, sources);
    const olderHref = result.nextCursor
      ? `/events${buildQueryString({ q, qtext, cursor: result.nextCursor })}`
      : null;

    return (
      <div className="space-y-6">
        <Header
          title="Events"
          subtitle={
            result.scanCapped
              ? `Searched the most recent ${result.scanned.toLocaleString()} events — narrow by source or time to reach older ones.`
              : `${result.events.length} match${result.events.length === 1 ? "" : "es"} on this page.`
          }
        />
        <EventsSearch initialText={qtext ?? ""} />
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-zinc-500">Interpreted as:</span>
          {chips.map((c, i) => (
            <span key={i} className="rounded bg-zinc-100 px-2 py-0.5 text-xs font-medium dark:bg-zinc-800">{c}</span>
          ))}
          <Link href="/events" className="ml-2 text-xs text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100">
            Clear search
          </Link>
        </div>

        <EventsBulkActions events={result.events} />

        <div className="flex items-center justify-end text-sm">
          {olderHref && (
            <Link href={olderHref} className="text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100">
              Older →
            </Link>
          )}
        </div>
      </div>
    );
  }

  // ---- Normal filter-bar mode -------------------------------------------
  const statusValue: DeliveryStatusValue | null =
    status && STATUS_VALUES.has(status as DeliveryStatus)
      ? (status as DeliveryStatusValue)
      : null;

  const where = buildEventWhere(userId, {
    sourceId: sourceId ?? null,
    receivedAfter:
      since && SINCE_MS[since]
        ? new Date(Date.now() - SINCE_MS[since]).toISOString()
        : null,
    receivedBefore: null,
    status: statusValue ? [statusValue] : null,
  });

  const take = PAGE_SIZE + 1;
  const events = await prisma.event.findMany({
    where,
    orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
    take,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: {
      source: { select: { name: true } },
      deliveries: { select: { status: true } },
    },
  });

  const hasOlder = events.length > PAGE_SIZE;
  const visible = hasOlder ? events.slice(0, PAGE_SIZE) : events;
  const oldestId = visible.at(-1)?.id;

  const COUNT_CAP = 1000;
  const counted = await prisma.event.findMany({ where, select: { id: true }, take: COUNT_CAP + 1 });
  const totalCount = counted.length;
  const totalCountCapped = totalCount > COUNT_CAP;

  const filterQuery = { sourceId, status, since };
  const newestHref = `/events${buildQueryString(filterQuery)}`;
  const olderHref = oldestId
    ? `/events${buildQueryString({ ...filterQuery, cursor: oldestId })}`
    : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <Header
          title="Events"
          subtitle={`${totalCountCapped ? `${COUNT_CAP.toLocaleString()}+` : totalCount.toLocaleString()} event${totalCount === 1 ? "" : "s"} match${totalCount === 1 ? "es" : ""} your filters.${cursor ? " Paginating older." : ""}`}
        />
        <EventsFilter sources={sources} />
      </div>

      <EventsSearch />

      <EventsBulkActions events={visible} />

      <div className="flex items-center justify-between text-sm">
        <div>
          {cursor && (
            <Link href={newestHref} className="text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100">
              ← Jump to newest
            </Link>
          )}
        </div>
        <div>
          {hasOlder && olderHref && (
            <Link href={olderHref} className="text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100">
              Older →
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}

function Header({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-1 text-sm text-zinc-500">{subtitle}</p>
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Manual verification**

Start dev env (`docker compose up -d`, `npm run dev`, `npm run worker`), sign in via MailHog (`localhost:8025`), open `/events`. Confirm: the filter bar still works (normal mode), the search box renders, "Compile" shows chips (requires an Anthropic key in Settings → API Keys), "Run search" navigates to `?q=…` and lists matches.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(dashboard)/events/page.tsx"
git commit -m "feat(search): events page search mode + buildEventWhere refactor

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 12: REST API — `POST /api/v1/events/search`

**Files:**
- Create: `src/app/api/v1/events/search/route.ts`
- Create: `src/app/api/v1/events/search/route.test.ts`

> Before writing: skim `node_modules/next/dist/docs/` for Next 16 route-handler conventions.

- [ ] **Step 1: Write failing test** — `src/app/api/v1/events/search/route.test.ts`

```ts
import "dotenv/config";
import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/prisma";
import { generateToken } from "@/lib/api/token";
import { POST } from "./route";

function uniq(p: string) {
  return `${p}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
function req(body: unknown, raw: string | null): Request {
  return new Request("https://x/api/v1/events/search", {
    method: "POST",
    headers: { "content-type": "application/json", ...(raw ? { authorization: `Bearer ${raw}` } : {}) },
    body: JSON.stringify(body),
  });
}
const noParams = { params: Promise.resolve({}) };

async function userWithToken() {
  const user = await prisma.user.create({ data: { email: `${uniq("apis")}@test.local` } });
  const t = generateToken();
  await prisma.apiToken.create({ data: { userId: user.id, name: "t", tokenHash: t.hash, prefix: t.prefix } });
  return { user, raw: t.raw };
}

describe("POST /api/v1/events/search", () => {
  it("401s without a token", async () => {
    const res = await POST(req({ q: "failed events" }, null), noParams);
    expect(res.status).toBe(401);
  });

  it("400s when the user has no Anthropic key", async () => {
    const { raw } = await userWithToken();
    const res = await POST(req({ q: "failed events" }, raw), noParams);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toMatch(/Anthropic API key/i);
  });

  it("400s on a missing q", async () => {
    const { raw } = await userWithToken();
    const res = await POST(req({}, raw), noParams);
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run src/app/api/v1/events/search/route.test.ts`
Expected: FAIL — `Cannot find module './route'`.

- [ ] **Step 3: Implement** `src/app/api/v1/events/search/route.ts`

```ts
import { NextResponse } from "next/server";
import { z } from "zod";

import { withApiAuth, readJson, apiError } from "@/lib/api/handler";
import { NoUserApiKeyError } from "@/lib/anthropic";
import { searchEvents } from "@/lib/services/search";
import { SearchCompileError } from "@/lib/ai/search-compiler";

export const runtime = "nodejs";

const SearchInput = z.object({
  q: z.string().min(1),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export const POST = withApiAuth(async (req, auth) => {
  const { q, cursor, limit } = SearchInput.parse(await readJson(req));

  try {
    const r = await searchEvents(auth.userId, q, { cursor, limit });
    return NextResponse.json({
      query: r.query,
      summary: r.summary,
      events: r.events.map((e) => ({
        id: e.id,
        sourceId: e.sourceId,
        method: e.method,
        receivedAt: e.receivedAt.toISOString(),
        remoteIp: e.remoteIp,
        idempotencyKey: e.idempotencyKey,
      })),
      scanned: r.scanned,
      scanCapped: r.scanCapped,
      nextCursor: r.nextCursor,
    });
  } catch (err) {
    // BYOK-missing and uninterpretable queries are user-facing 400s. Anything
    // else (Anthropic network/SDK errors) rethrows → 500 via withApiAuth.
    if (err instanceof NoUserApiKeyError) {
      return apiError("validation_error", "No Anthropic API key configured (set one in Settings → API Keys).");
    }
    if (err instanceof SearchCompileError) {
      return apiError("validation_error", "Could not interpret the search query. Try rephrasing.");
    }
    throw err;
  }
});
```

- [ ] **Step 4: Run test, verify pass**

Run: `npx vitest run src/app/api/v1/events/search/route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/v1/events/search/route.ts src/app/api/v1/events/search/route.test.ts
git commit -m "feat(search): POST /api/v1/events/search

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 13: MCP tool — `search_events`

**Files:**
- Modify: `src/lib/mcp/tools.ts`
- Modify: `src/lib/mcp/server.ts` (one error-mapping line)
- Modify: `src/lib/mcp/tools.test.ts`

- [ ] **Step 1: Write failing tests** — append to `src/lib/mcp/tools.test.ts`

Add `"search_events"` to the registry expectation in the first test:
```ts
        "list_sources", "get_source", "list_deliveries", "list_events",
        "create_route", "set_route_filter", "compile_filter", "pause_destination",
        "search_events",
```

Add a new test:
```ts
  it("search_events requires an Anthropic key", async () => {
    const user = await prisma.user.create({ data: { email: `${uniq("mcps")}@test.local` } });
    await expect(
      findTool("search_events")!.handler(user.id, { query: "failed events yesterday" }),
    ).rejects.toThrow(/Anthropic API key/i);
  });
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run src/lib/mcp/tools.test.ts`
Expected: FAIL — registry array missing `search_events`; `findTool("search_events")` is undefined.

- [ ] **Step 3: Register the tool** in `src/lib/mcp/tools.ts`

Add the import near the other service imports:
```ts
import { searchEvents } from "@/lib/services/search";
```

Add this tool to the `tools` array, in the `// ---------- BYOK ----------` section (after `compile_filter`):
```ts
  defineTool({
    name: "search_events",
    description:
      "Search received events in plain English across metadata (source, time, delivery status) AND payload content (fields inside the JSON body). Returns the compiled query plus matching events (newest first, with a 500-char body preview). Read-only. Requires the user's Anthropic key (Settings → API Keys).",
    inputSchema: z.object({
      query: z.string().min(1),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    handler: async (u, i) => {
      const r = await searchEvents(u, i.query, { limit: i.limit });
      return {
        query: r.query,
        summary: r.summary,
        scanned: r.scanned,
        scanCapped: r.scanCapped,
        nextCursor: r.nextCursor,
        events: r.events.map((e) => ({
          id: e.id,
          source: e.source.name,
          receivedAt: e.receivedAt.toISOString(),
          statuses: e.deliveries.map((d) => d.status),
          bodyPreview: e.bodyRaw.slice(0, 500),
        })),
      };
    },
  }),
```

- [ ] **Step 4: Map the compile error** in `src/lib/mcp/server.ts` `mapDomainError`, after the existing `No Anthropic API key configured` line:
```ts
    if (/^could not interpret the search/i.test(err.message)) return toolError(err.message);
```

- [ ] **Step 5: Run tests, verify pass**

Run: `npx vitest run src/lib/mcp/tools.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/mcp/tools.ts src/lib/mcp/server.ts src/lib/mcp/tools.test.ts
git commit -m "feat(search): search_events MCP tool

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification

- [ ] **Run the full test suite**

Run: `npm test`
Expected: all green (Postgres must be up for DB-backed suites).

- [ ] **Type-check the whole project**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Lint**

Run: `npm run lint`
Expected: no errors.

- [ ] **Update the wishlist** — in `~/.claude/plans/ok-as-you-can-concurrent-engelbart.md`, mark #13 (NL event search) shipped in the progress snapshot. (Marketing/docs Tier 3.5 remains.)

- [ ] **Update docs** — add `POST /api/v1/events/search` and the `search_events` MCP tool to `infra/README.md`'s "Notable endpoints" / MCP tool count, and regenerate/update `/openapi.json` if it is hand-maintained.

- [ ] **Finish the branch** — use `superpowers:finishing-a-development-branch` to open a PR for `feat/nl-event-search`.

---

## Notes & invariants (read before implementing)

- **Result rows are reused as-is by the dashboard.** `SearchResultEvent` (from `run.ts`) structurally satisfies `BulkEventRow` (`{ id, method, receivedAt: Date, source: { name }, deliveries: { status }[] }`), which is why `EventsBulkActions events={result.events}` type-checks. Don't narrow the `include` in `run.ts` or you'll break the dashboard.
- **Never trust a query from the client.** `decodeEventQuery` re-runs `validateEventQuery`; `buildEventWhere` always scopes `source: { userId }`, so a foreign/stale `sourceId` returns zero rows rather than leaking.
- **`bodyRaw` is text, eval is in-memory.** Payload predicates are bounded by `SCAN_CAP`; broad metadata + a rare payload value yields the "searched the most recent N" state. This is intended (no JSONB migration).
- **BYOK everywhere.** The compiler always uses the caller's Anthropic key (`anthropicFor`); missing key → friendly message on every surface.
- **DeliveryStatus list** in `src/lib/search/types.ts` must stay in sync with `prisma/schema.prisma`'s `DeliveryStatus` enum.
