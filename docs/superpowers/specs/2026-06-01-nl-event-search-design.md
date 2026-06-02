# Natural-language event search — design

**Date:** 2026-06-01
**Status:** Approved (pre-implementation)
**Feature:** Wishlist item #13 from `~/.claude/plans/ok-as-you-can-concurrent-engelbart.md` — the last remaining Tier-3 AI differentiator.

## Goal

Let a user search received webhook events in plain English — across both event
**metadata** (source, time, delivery status) and **payload content** (fields inside
the JSON body, e.g. `customer.email`). Claude compiles the English into a structured,
deterministic query that reuses the existing filter AST; the query then executes as a
SQL prefilter plus an in-memory AST evaluation.

Example: *"failed Stripe events from yesterday where the customer email ends in @gmail.com"*
→ `source = stripe`, `receivedAt` in yesterday's range, a delivery with `status = failed`,
and payload `endsWith($.data.object.customer_email, "@gmail.com")`.

## Decisions (locked during brainstorming)

| Decision | Choice |
|---|---|
| Surfaces | Dashboard events page **+** REST API **+** MCP tool |
| Payload matching | Extend the filter AST with `startsWith` / `endsWith` (no regex) |
| Dashboard UX | Two-step: **compile → confirm/edit → run** |
| Time handling | Resolve NL time to **absolute ISO ranges** at compile time (not fixed windows) |
| Execution model | SQL `WHERE` for metadata + **in-memory** AST eval for payload (bodyRaw is `text`, not JSONB) |

## Non-goals (v1)

- No JSONB migration of `Event.bodyRaw` (stays `text`; payload eval is in-memory).
- No regex AST node (ReDoS surface; `startsWith`/`endsWith`/`contains` cover the need).
- No saved searches, search history, or result caching (each compile = one BYOK call).
- No cross-page total match count for payload queries (too expensive; we report per-page + a scan-cap flag).

---

## Architecture

One shared engine; three thin surface adapters call it.

```
NL string
   │  compileEventSearch()  ── BYOK Claude, grounded on sources + sample bodies
   ▼
EventQuery { metadata, payload: FilterAst|null }   ── validated, never trusted from client
   │  runEventSearch()
   ▼
buildEventWhere() → Prisma WHERE (source, receivedAt range, delivery status)
   │  fetch newest-first up to SCAN_CAP
   ▼
in-memory evaluateFilter(payload, JSON.parse(bodyRaw))  ── skip rows that fail to parse
   ▼
{ events, scanned, scanCapped, nextCursor }
```

### Component map

| File | New/changed | Responsibility |
|---|---|---|
| `src/lib/filters/evaluator.ts` | changed | Add `startsWith` / `endsWith` AST nodes (type, evaluator, validator) |
| `src/lib/ai/rule-compiler.ts` | changed | Add the two new ops to the route-filter compiler grammar |
| `src/lib/search/types.ts` | new | `EventQuery` type + `validateEventQuery()` |
| `src/lib/search/where.ts` | new | `buildEventWhere(userId, metadata)` → Prisma `WHERE` |
| `src/lib/search/describe.ts` | new | `describeEventQuery(query, sources)` → human-readable chip labels |
| `src/lib/search/run.ts` | new | `runEventSearch()` — the execution engine + scan-cap pagination |
| `src/lib/ai/search-compiler.ts` | new | `compileEventSearch()` — NL → validated `EventQuery` + summary |
| `src/lib/actions/search.ts` | new | Server action wrapping the compiler for the dashboard (compile-only preview) |
| `src/app/(dashboard)/events/page.tsx` | changed | Use `buildEventWhere`; render search mode when `?q=` present |
| `src/components/events-search.tsx` | new | Client component: input → compile → confirm chips → run |
| `src/app/api/v1/events/search/route.ts` (+ `route.test.ts`) | new | `POST` — compile + run in one call |
| `src/lib/mcp/tools.ts` | changed | Register `search_events` tool |

---

## 1. Filter AST extension

`src/lib/filters/evaluator.ts` gains two nodes, modeled exactly on the existing
`contains` node (case-insensitive, string-only — a non-string value at the path yields
no match):

```ts
| { startsWith: [JsonPath, string] }
| { endsWith:   [JsonPath, string] }
```

- **evaluateFilter:** read the path; if the value is a string, return
  `value.toLowerCase().startsWith(needle.toLowerCase())` (resp. `endsWith`); otherwise `false`.
- **validateFilterAst:** add `startsWith` / `endsWith` to the 2-element `[path, value]`
  cases with a `typeof value === "string"` check (same branch as `contains`).
- **rule-compiler.ts** `SYSTEM_PROMPT`: add the grammar lines
  `{ "startsWith": ["$.path", "prefix"] }` and `{ "endsWith": ["$.path", "suffix"] }`
  so route filters also gain the capability for free.

## 2. EventQuery type + validation

`src/lib/search/types.ts`:

```ts
export type EventQuery = {
  metadata: {
    sourceId: string | null;        // resolved from a source name/slug by the compiler
    receivedAfter: string | null;   // ISO 8601
    receivedBefore: string | null;  // ISO 8601
    status: DeliveryStatus[] | null; // one or more; e.g. ["failed","exhausted"] for "failures"
  };
  payload: FilterAst | null;        // existing AST, validated via validateFilterAst
};
```

`validateEventQuery(input): EventQuery` enforces:
- `metadata.sourceId`: `string | null`.
- `metadata.receivedAfter` / `receivedBefore`: `string | null`; if a string, must be a
  parseable date (`Number.isFinite(Date.parse(x))`) — normalize to `new Date(x).toISOString()`.
- `metadata.status`: `null`, or a non-empty array of `DeliveryStatus` enum values
  (`pending | in_flight | delivered | failed | exhausted`); reject unknown values, and
  normalize an empty array to `null`.
- `payload`: `null`, or run through the existing `validateFilterAst`.
- Throws a descriptive error on any mismatch.

Ownership of `sourceId` is **not** checked here — it is enforced structurally by
`buildEventWhere` (the `WHERE` always includes `source: { userId }`, so a foreign or stale
`sourceId` simply returns zero rows).

## 3. Shared WHERE builder

`src/lib/search/where.ts`:

```ts
export function buildEventWhere(
  userId: string,
  md: EventQuery["metadata"],
): Prisma.EventWhereInput
```

Maps:
- always `source: { userId }`
- `sourceId` → `sourceId` (when set)
- `receivedAfter` / `receivedBefore` → `receivedAt: { gte, lt }` (whichever are set)
- `status` (non-empty array) → `deliveries: { some: { status: { in: status } } }`

**Refactor:** `events/page.tsx` currently inlines this logic. Move it here and have the
page call it. The page keeps its `SINCE_MS` window dropdown and single-status filter — it
converts the chosen window to a `receivedAfter` `Date` and wraps its single status as a
one-element array before passing a metadata-shaped object to `buildEventWhere`. The
filter-bar UX is unchanged; the helper becomes the single source of truth.

## 4. The compiler

`src/lib/ai/search-compiler.ts`, mirroring `compileFilterForSource` / `compileRule`:

```ts
export async function compileEventSearch(
  userId: string,
  prompt: string,
  opts?: { now?: Date; timeZone?: string },
): Promise<{ query: EventQuery; summary: string[] }>
```

- BYOK via `anthropicFor(userId)` (throws `NoUserApiKeyError` if unset).
- **Grounding:** load the user's sources (`{ id, name, slug }`) so Claude can resolve a
  named source ("stripe") to a `sourceId`; load the newest 20 event bodies across the
  user's sources (each tagged with its source name) for payload-path grounding.
- **System prompt** describes: the `EventQuery` JSON shape; the allowed `status` enum; the
  source list; the full filter-AST grammar including `startsWith` / `endsWith`; the current
  timestamp (`opts.now ?? new Date()`) and `opts.timeZone` (default `"UTC"`); and the
  instruction to resolve any relative time expression to an absolute
  `receivedAfter`/`receivedBefore` range. Output JSON only.
- Model: `MODEL_DEFAULT` (consistency with the route compiler).
- Parse with `extractJsonText` → `JSON.parse` → `validateEventQuery`. If the returned
  `sourceId` is not in the loaded sources, coerce it to `null`.
- **Summary is derived server-side** from the validated query via `describeEventQuery`
  (see §5), never from Claude's prose — so the chips the user sees always equal what runs.

`describeEventQuery(query, sources)` (`src/lib/search/describe.ts`) returns chip labels,
e.g. `["source: Stripe", "May 1 – Jun 1", "failed", 'body: email ends with "@gmail.com"']`.
It includes a small recursive printer for the AST (handles and/or/not + every leaf op;
falls back to compact JSON for anything unexpected).

## 5. The execution engine

`src/lib/search/run.ts`:

```ts
export const SCAN_CAP = 2000;   // max metadata-matching rows scanned per request
export const SCAN_BATCH = 200;  // page size while scanning for payload matches

export async function runEventSearch(
  userId: string,
  query: EventQuery,
  opts: { cursor?: string | null; limit?: number },
): Promise<{
  events: SearchResultEvent[];   // matches on this page (count = events.length)
  scanned: number;       // rows scanned this request
  scanCapped: boolean;   // hit SCAN_CAP with more rows still unscanned
  nextCursor: string | null;
}>
```

`SearchResultEvent` carries everything every surface needs; each surface projects down:
event core fields (`id`, `sourceId`, `method`, `receivedAt`, `remoteIp`, `idempotencyKey`),
`source: { name }`, and `deliveries: { status }[]` — the same `include` the events page
already uses.

`limit` defaults to 50, clamped 1..100. `where = buildEventWhere(userId, query.metadata)`,
ordered `[{ receivedAt: "desc" }, { id: "desc" }]`.

**Fast path — `payload === null`:** plain keyset pagination (identical to today's page):
`take: limit + 1`, cursor via `{ cursor: { id }, skip: 1 }`; `nextCursor` = the (limit+1)th
row's id or null. `scanned = events.length`, `scanCapped = false`.

**Payload path — `payload` present:** scan newest-first in batches of `SCAN_BATCH`,
`JSON.parse(bodyRaw)` (rows that fail to parse are skipped — same try/catch as
`compileFilterForSource`), run `evaluateFilter(payload, parsed)`, accumulate matches.
Stop when **any** of:
1. `limit + 1` matches collected → drop the extra; `nextCursor` = id of the last **scanned**
   row (next request resumes scanning after it via `skip: 1`); `scanCapped = false`.
2. `scanned >= SCAN_CAP` → `scanCapped = true`; `nextCursor` = id of the last scanned row
   (so the caller can continue scanning older events with another request).
3. no more rows → `nextCursor = null`.

This bounds work to ≤ `SCAN_CAP` rows per request and is resumable across pages without
ever re-scanning. Total match count across all pages is intentionally not computed.

---

## 6. Surfaces

### 6a. Dashboard (`/events`)

Two-step confirm, URL-driven so pagination/refresh never re-invoke the LLM:

1. **`src/components/events-search.tsx`** (client): a text input + "Compile" button. On
   compile it reads the browser timezone (`Intl.DateTimeFormat().resolvedOptions().timeZone`)
   and calls the server action.
2. **`src/lib/actions/search.ts`** `previewSearch(prompt, timeZone)` (named to mirror
   `previewRule`, and to avoid clashing with the lib's `compileEventSearch`): `requireUserId`,
   call the compiler, return `{ query, summary }` — **preview only**, no navigation.
3. The component renders the `summary` chips + **"Run search"** / **"Edit"**.
4. **"Run search"** serializes the validated `query` as JSON into a `?q=` param
   (percent-encoded by `URLSearchParams`; plus `?qtext=` with the original text for
   edit/repopulation) and `router.push("/events?q=…")`.
5. **`events/page.tsx`**: when `?q=` is present → decode + `validateEventQuery` (on failure,
   render a friendly "couldn't read that search" with a clear-search link) → `runEventSearch`
   → render results (reuse the existing `EventsBulkActions` list, which already takes events
   with `source.name` + `deliveries.status`) + the interpretation chips + a
   "searched the most recent N events — narrow by source/time for older" note when
   `scanCapped`. A **"clear search"** link returns to the normal filter-bar mode. When `?q=`
   is absent, the page behaves exactly as today.
6. Pagination in search mode carries `q` + `cursor`; the normal filter bar still works when
   no `q` is present.

**No API key:** the action throws `NoUserApiKeyError`; the component shows an inline message
linking to **Settings → API Keys** (`/settings/api-keys`).

### 6b. REST API — `POST /api/v1/events/search`

Modeled on `src/app/api/v1/fixtures/route.ts` (the existing BYOK-in-API precedent):

- Wrapped in `withApiAuth` (API-token auth + per-token rate limit + error mapping).
- Body (`zod` via `readJson`): `{ q: string (min 1), cursor?: string, limit?: number (1..100) }`.
- BYOK: `getUserApiKey(auth.userId)`; if null → `apiError("validation_error", "No Anthropic
  API key configured (set one in Settings → API Keys).")`.
- Compile (default `timeZone: "UTC"` — no browser) **and** run in one call.
- On success → `NextResponse.json({ query, summary, events, scanned, scanCapped,
  nextCursor })`, where `events` are projected to the existing `EventDTO` shape for
  consistency with `GET /api/v1/events`.
- Map a known "couldn't interpret" compiler error to `apiError("validation_error", …)`;
  rethrow anything else so it becomes a 500 (Sentry-captured, no raw SDK message leaked) —
  same discipline as the fixtures route.

### 6c. MCP tool — `search_events`

Register in `src/lib/mcp/tools.ts` (BYOK section, beside `compile_filter`; read-only, so it
respects the "no destructive tools" rule):

- `inputSchema`: `z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(100).optional() })`.
- Handler `(userId, input)` calls a shared service `searchEvents(userId, input.query, { limit })`
  that runs compile + run (default `timeZone: "UTC"`) and returns `{ query, summary, events,
  scanned, scanCapped, nextCursor }`, with `events` trimmed for token economy
  (`id`, source name, `receivedAt`, delivery statuses, and a `bodyRaw` preview of the first 500 chars).
- Description states it requires the user's Anthropic key and searches both metadata and
  payload content.

> To avoid duplicating "compile + run" across the API route and the MCP handler, extract a
> single `searchEvents(userId, prompt, opts)` orchestrator in `src/lib/search/run.ts` that
> both call; the dashboard keeps its split compile/run for the two-step UX.

---

## 7. Error handling

| Condition | Behavior |
|---|---|
| No Anthropic key | Dashboard: inline link to Settings → API Keys. API: `validation_error`. MCP: error result with the same message. |
| Claude returns unparseable / invalid query | `validateEventQuery` throws → "couldn't interpret that query, try rephrasing" (400 on API). |
| `bodyRaw` not valid JSON | Row counts as non-match (try/catch), consistent with existing AI filter code. |
| Scan cap hit | `scanCapped: true` surfaced on every surface; dashboard shows the "most recent N" note. |
| Foreign/stale `sourceId` in `?q=` | Yields zero rows (WHERE is scoped by `source: { userId }`); no error. |

## 8. Testing

- **evaluator.ts** — unit tests for `startsWith` / `endsWith`: match, case-insensitivity,
  non-string value → false; plus `validateFilterAst` accepts the new nodes and rejects
  non-string values.
- **types.ts** — `validateEventQuery`: valid query round-trips; bad date / bad status /
  malformed payload throw.
- **run.ts** — seeded events: WHERE mapping (source/time/status), in-memory payload eval,
  scan-cap behavior, and resumable cursor pagination (fast path and payload path).
- **search-compiler.ts** — mock the Anthropic client (precedent: `event-diff.test.ts`,
  `fixtures.test.ts`); assert it validates output and coerces a foreign `sourceId` to null.
- **API** — `src/app/api/v1/events/search/route.test.ts` mirroring the existing
  `events/route.test.ts`: auth required, no-key → 400, happy path shape.
- **MCP** — extend `src/lib/mcp/tools.test.ts` for `search_events` registration + dispatch.

## 9. Timezone note (v1 simplification)

The dashboard passes the browser timezone, so "yesterday" resolves to the user's local day.
The API and MCP have no browser context and default to **UTC** day boundaries. An explicit
`tz` parameter can be added to both later if anyone needs non-UTC scripting; out of scope for v1.

## 10. Build order (high level — detailed plan follows separately)

1. AST `startsWith`/`endsWith` (evaluator + validator + compiler grammar) + tests.
2. `types.ts` + `where.ts` (+ refactor the events page onto `where.ts`) + tests.
3. `describe.ts` + `search-compiler.ts` + tests.
4. `run.ts` engine (+ `searchEvents` orchestrator) + tests.
5. Dashboard: server action + `events-search.tsx` + page search mode.
6. REST API route + test.
7. MCP `search_events` tool + test.

> Per `AGENTS.md`, this repo runs a modified Next.js 16 — consult
> `node_modules/next/dist/docs/` for App Router / server-action / route-handler specifics
> before writing the dashboard and API code.
