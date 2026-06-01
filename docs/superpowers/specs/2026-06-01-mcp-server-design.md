# Odyhook MCP Server — Design Spec

- **Date:** 2026-06-01
- **Status:** Approved (pending spec review)
- **Feature:** #12 "MCP server" from the competitor gap analysis (Tier 3 — AI differentiators)

## Goal

Expose Odyhook's sources, destinations, routes, events, and deliveries as **MCP tools** so a user with an MCP-capable agent (e.g. Claude Code) can operate their webhook router in natural language — e.g. *"show me yesterday's failed Stripe deliveries"* or *"create a route from `gh-prod` to `slack-alerts` that filters for pushes to main."*

The MCP server is a **second protocol facade** over the existing service layer — it adds no new business logic, auth model, or process. It deploys with the web app.

## Non-goals (v1)

- **Destructive operations** (`delete_*`) — excluded from the tool surface.
- **Replay / cancel** — valuable but the logic currently lives inside bulk route handlers, not a reusable service; deferred to a post-v1 stretch (see "Stretch").
- **OAuth / a separate token type** — reuse existing `ody_` API tokens unchanged.
- **Natural-language event *search*** — that is feature #13, a separate spec.
- **Server→client streaming / session state** — our tools are request/response; the endpoint runs stateless (no session store, no Redis session state).
- **Next.js built-in MCP** (`/_next/mcp` / `next-devtools-mcp`) — that is a *devtools* server for agents to introspect a running app (errors, routes, logs). It is unrelated to exposing product domain tools and is not used here. Our endpoint lives at its own path; no collision.

## Decisions (the three forks settled during brainstorming)

1. **Transport:** Remote HTTP MCP at `/api/mcp`, authenticated by the existing `ody_` API token. Zero install for users; tools call the service layer directly.
2. **Tool surface:** Read + **safe** writes (create/update + pause/resume), **no destructive deletes**.
3. **Filters:** Provide **both** a structured `filter` on `create_route`/`set_route_filter` *and* a server-side BYOK `compile_filter` tool (NL → AST) for web-UI parity. The agent can also hand-author an AST and skip `compile_filter`.

### Scope confirmed (2026-06-01)

The three open questions from spec review were resolved as follows:

- **Ship the full 20-tool surface.** The safe-write tools wrap existing services, so they're near-free and make "manage your webhooks from Claude" real rather than read-only (pause/resume is also a stated operational-safety story). Kept.
- **Defer public-REST exposure** of the new filters (`/api/v1/deliveries`, `/api/v1/events` params, OpenAPI). The services are built here (MCP needs them); exposing them on REST is a thin follow-up — see "REST consistency".
- **Defer `replay_events` / `cancel_deliveries`** — they need extraction refactors of the bulk route handlers and aren't required for either flagship flow. See "Stretch".

## Architecture

A single route handler at `src/app/api/mcp/route.ts` (`export const runtime = "nodejs"`), exporting `POST` (and `GET` only if the chosen transport needs an SSE channel). It is a thin protocol adapter — exactly like the existing `src/app/api/v1/*` routes are thin adapters over `src/lib/services/*`.

```
Claude Code ──HTTP POST (JSON-RPC / MCP)──▶ /api/mcp
                                             │ authenticateApiToken(req) → { userId, tokenId }   (401 if missing/invalid)
                                             │ checkApiRateLimit(tokenId)                         (429 if exceeded; fail-open on Redis error)
                                             ▼
                                   MCP dispatch (initialize | tools/list | tools/call)
                                             │  shared try/catch error mapper (mirrors withApiAuth)
                                             ▼
                                   src/lib/services/*  (every call userId-scoped)  ──▶ Postgres
                                   src/lib/ai/rule-compiler (compile_filter only)   ──▶ Anthropic (BYOK)
```

Reuses, unchanged:
- **Auth:** `authenticateApiToken(req)` from `src/lib/api/authenticate.ts` → `{ userId, tokenId }`. Precedent: `/api/v1/listen` (the CLI's SSE endpoint) authenticates the same way.
- **Rate limiting:** `checkApiRateLimit(tokenId)` from `src/lib/ratelimit.ts` (fail-open on Redis errors, matching existing behavior).
- **Tenancy + validation:** every service function already takes `userId` first and validates input with Zod; isolation and validation are inherited, not reinvented.

Users connect via:
```
claude mcp add --transport http odyhook https://odyhook.dev/api/mcp \
  --header "Authorization: Bearer ody_…"
```
(Tokens are minted at Settings → API Tokens, which already exists.)

## Protocol-layer approach

No MCP SDK is currently installed. Two viable builds, decided by a spike (below):

- **Approach A (recommended):** official `@modelcontextprotocol/sdk` with `StreamableHTTPServerTransport`, bridged into the Next route handler. Protocol-correct (handshake, capability negotiation, JSON-RPC framing, error codes), maintained, leaves room for resources/prompts later. **Risk:** bridging the SDK's Node-stream transport to Next 16's Web `Request`/`Response`; verify against pinned Next **16.2.3**.
- **Approach C (fallback):** hand-rolled minimal JSON-RPC implementing `initialize`, `tools/list`, `tools/call` (+ notifications) as a pure POST handler. Zero deps, native to the route handler, full control. Safe here because the surface is **small and stateless**, and the app already does SSE in `/api/v1/listen` if a channel is ever needed. **Cost:** we own protocol correctness and future MCP spec drift.

(`mcp-handler` / `@vercel/mcp-adapter` was considered and set aside: extra dependency targeting Next "as commonly known", uncertain against the project's pinned/patched Next 16 — see `AGENTS.md`.)

**First implementation step is a spike:** stand up `/api/mcp` with a single `ping` tool and confirm `claude mcp add … http://localhost:3000/api/mcp` connects against Next 16.2.3. If the SDK bridge fights the Web `Request`/`Response` model, fall back to Approach C.

## Tool catalog

20 tools (9 reads + 10 safe writes + `compile_filter`). Most wrap an existing `userId`-scoped service 1:1; the genuinely new backend work is the four service additions marked ⭐ in the next section.

### Reads
| Tool | Backed by | Input | Notes |
|---|---|---|---|
| `list_sources` | `listSources` | `{ limit?, cursor? }` | DTO includes `slug` + `verifyStyle` → lets the agent resolve "Stripe" (`verifyStyle === "stripe"`) |
| `get_source` | `getSource` | `{ id }` | |
| `list_destinations` | `listDestinations` | `{ limit?, cursor? }` | DTO includes `enabled`, `consecutiveFailures`, `autoDisabledAt` |
| `get_destination` | `getDestination` | `{ id }` | |
| `list_routes` | `listRoutes` | `{ limit?, cursor? }` | DTO includes `hasFilter` |
| `get_route` | `getRoute` | `{ id }` | |
| `list_events` | `listEvents` ⭐(+filters) | `{ sourceId?, since?, until?, limit?, cursor? }` | new optional filters; uses the `(sourceId, receivedAt)` index |
| `get_event` | `getEvent` | `{ id }` | full body, headers, deliveries |
| `list_deliveries` | `listDeliveries` ⭐(new) | `{ sourceId?, destinationId?, status?, since?, until?, limit?, cursor? }` | **flagship "failed Stripe deliveries" query**; `status` accepts one-or-many of `pending\|in_flight\|delivered\|failed\|exhausted` |

### Safe writes (no deletes)
| Tool | Backed by | Input | Notes |
|---|---|---|---|
| `create_source` | `createSource` | `{ name, verifyStyle?, signingSecret? }` | slug auto-generated |
| `update_source` | `updateSource` | `{ id, name?, verifyStyle?, signingSecret?, rateLimitPerSec?, rateLimitBurst? }` | |
| `create_destination` | `createDestination` | `{ name, url, headers?, timeoutMs?, outboundSecret? }` | reuses existing create schema |
| `update_destination` | `updateDestination` | `{ id, name?, url?, enabled?, … }` | |
| `pause_destination` | `updateDestination({ enabled:false })` | `{ id }` | thin sugar (clearer agent intent) |
| `resume_destination` | `updateDestination({ enabled:true })` | `{ id }` | resume auto-clears circuit-breaker fields (`autoDisabledAt`/`Reason`) — existing service behavior |
| `create_route` | `createRoute` + `setRouteFilter` ⭐ | `{ sourceId, destinationId, enabled?, filter? }` | `filter` is an **optional structured AST**; if present, create then set filter |
| `update_route` | `updateRoute` | `{ id, enabled? }` | |
| `set_route_filter` | `setRouteFilter` ⭐(new) | `{ routeId, ast }` | persists a structured AST deterministically (no LLM) |
| `clear_route_filter` | `clearRouteFilter` ⭐(new) | `{ routeId }` | |

### BYOK tool (the only one needing an Anthropic key)
| Tool | Backed by | Input | Notes |
|---|---|---|---|
| `compile_filter` | `compileFilterForSource` ⭐(new) | `{ sourceId, prompt }` | NL → AST, **preview only (no persist)**; returns `{ ast, matchedCount, totalCount }` grounded on the source's recent ~50 events. Mirrors the web UI's "matches N of last 50" check |

### Excluded / stretch
- **Excluded (destructive):** `delete_source`, `delete_destination`, `delete_route`.
- **Stretch (post-v1):** `replay_events`, `cancel_deliveries` — require extracting logic from the bulk route handlers (`src/app/api/events/bulk-replay/route.ts`, `bulk-cancel/route.ts`) into reusable services first.

### Flagship end-to-end flow ("create a route … filtering for pushes to main")
1. `compile_filter(sourceId, "pushes to main")` → `{ ast, matchedCount: 7, totalCount: 50 }` — sanity-check before committing.
2. `create_route(sourceId, destinationId, filter: ast)` → persists **deterministically, no LLM**.

Persistence tools never call Anthropic; `compile_filter` is the only BYOK tool. Because the client is already an LLM, the agent may instead hand-author an AST and skip step 1 — both paths coexist (per the "Both" decision). `compile_filter` earns its place by grounding the AST in real payloads and returning a match count the agent-authored path can't get.

## Service-layer changes (the four ⭐ additions — the real new code)

1. **`listEvents` + filters** — add optional `sourceId`, `since`, `until` to the existing `listEvents(userId, page)` (`src/lib/services/events.ts`). Uses the existing `Event @@index([sourceId, receivedAt])`.
2. **`listDeliveries(userId, filter)`** — new `src/lib/services/deliveries.ts`. Joins Delivery → Event → Source for `userId` scoping. Filters: `sourceId?`, `destinationId?`, `status?` (one-or-many `DeliveryStatus`), `since?`, `until?`, plus cursor pagination. Returns a `DeliveryDTO` enriched with `eventId` + `sourceId` for context.
3. **`setRouteFilter(userId, routeId, ast, prompt?)` + `clearRouteFilter(userId, routeId)`** — extract the persistence currently inside the `saveRule` / `deleteRule` server actions (`src/lib/actions/filters.ts`, which are `"use server"` + session auth + `FormData` + `revalidatePath` — not reusable). After extraction, **both** the web UI actions and the MCP tools call the same service functions. (Targeted improvement to code we're touching: one persistence path, not two.)
4. **`compileFilterForSource(userId, sourceId, prompt)`** — verify source ownership, load the source's recent ~50 events as samples, call the existing `compileRule(userId, prompt, samples)` (`src/lib/ai/rule-compiler.ts`), return `{ ast, matchedCount, totalCount }`. This generalizes the route-scoped `previewRule` to be source-scoped; `previewRule` should then delegate to it so there is one compile path.

### REST consistency (deferred to a follow-up)
The four service additions **are** built in this plan (MCP needs them). **Exposing** them on the public REST API — `GET /api/v1/events?sourceId=…&since=…&until=…`, a new `GET /api/v1/deliveries`, and `/openapi.json` updates — is **deferred to a separate follow-up** to keep #12 focused on the MCP surface. The services are written so this is a thin later addition, not a rework.

## Error handling

One shared mapper in the MCP dispatch, mirroring `withApiAuth` (`src/lib/api/handler.ts`):

| Condition | Result |
|---|---|
| Missing/invalid `ody_` token | **HTTP 401** (before dispatch) |
| Rate limit exceeded | **HTTP 429** via `checkApiRateLimit(tokenId)` (fail-open on Redis error) |
| `ZodError` (bad tool input) | MCP **invalid-params** (`-32602`) with issues — *protocol-level* |
| Unknown tool / unknown method | MCP **method-not-found** — *protocol-level* |
| `Error` matching `/not found/i` | tool result with `isError: true` |
| `RouteConflictError` | tool result with `isError: true` ("conflict: route already exists") |
| SSRF / `Invalid header` (`/^Destination URL rejected:/`, `/^Invalid header/`) | tool result with `isError: true` |
| `NoUserApiKeyError` / "No Anthropic API key configured" (compile_filter) | tool result with `isError: true` guiding to Settings → API Keys |
| Anything else | generic internal error (no internals leaked); Sentry captures server-side |

**Distinction:** malformed request / unknown tool / bad params are *protocol* (JSON-RPC) errors; domain failures are returned as *tool results* with `isError: true` so the agent can read and recover. (Approach A's SDK handles the framing; Approach C must implement it.)

## Schemas (single source of truth)

Every tool validates input with a Zod schema — reusing the existing `sourceCreateSchema`, `sourceUpdateSchema`, `routeCreateSchema`, destination create/update schemas, etc., and new schemas for `list_deliveries` filters and `compile_filter`. The JSON Schema advertised in `tools/list` is **generated from the same Zod schema** via zod v4's native `z.toJSONSchema()` (no extra dependency). Validate-and-advertise from one definition.

## Testing (Vitest 4, matching repo conventions)

- **Service unit tests** (`src/lib/services/*.test.ts` style):
  - `listDeliveries` — filtering by source/destination/status/time + **cross-user isolation**.
  - enriched `listEvents` — `sourceId`/`since`/`until` filters.
  - `setRouteFilter` / `clearRouteFilter` — persist, clear, ownership.
  - `compileFilterForSource` — mock `compileRule`/Anthropic; sample loading + ownership.
- **Dispatch tests** (`src/app/api/mcp/route.test.ts`, like the existing `src/app/api/v1/*/route.test.ts`):
  - 401 on missing/invalid token.
  - `initialize` handshake returns server info + capabilities.
  - `tools/list` returns the catalog with JSON Schemas.
  - `tools/call`: a read tool returns scoped data; a write tool mutates.
  - **Cross-user isolation**: token A cannot read or mutate user B's data.
  - Error mapping: invalid params → invalid-params; not-found → tool error; `compile_filter` without a BYOK key → guiding error.
- **Manual verification** (per the gap-analysis plan's Verification section):
  - `docker compose up -d` (pg/redis/mailhog), `npm run dev`, `npm run worker`.
  - Mint a token at Settings → API Tokens.
  - `claude mcp add --transport http odyhook http://localhost:3000/api/mcp --header "Authorization: Bearer ody_…"`.
  - Exercise: *"show me failed deliveries for my Stripe source"* and *"create a route from X to Y filtering for pushes to main."*

## Risks

- **SDK ↔ Next 16 bridge (Approach A)** — the main unknown. Mitigated by the `ping` spike as step 1; Approach C is a clean fallback.
- **Stateless assumption** — confirmed appropriate: tools are request/response with no server→client streaming, so no session store/Redis session state is needed. Re-confirm in the spike.

## Rough build sequence (for the implementation plan)

1. **Spike:** `/api/mcp` + a `ping` tool; confirm `claude mcp add` connects against Next 16.2.3. Pick Approach A or C.
2. **Service additions + unit tests:** `listEvents` filters, `listDeliveries` (new `deliveries.ts`), `setRouteFilter`/`clearRouteFilter` (extract from `filters.ts` actions; repoint UI actions), `compileFilterForSource` (generalize `previewRule`).
3. **Protocol layer:** dispatch + auth (`authenticateApiToken`) + rate limit + shared error mapper.
4. **Tool handlers + Zod schemas + `z.toJSONSchema()` advertisement.**
5. **`compile_filter`** (BYOK) wired to `compileFilterForSource`.
6. **Dispatch tests** + manual verification via `claude mcp add`.
7. *(Deferred — separate follow-up, not part of this plan)* REST consistency: `/api/v1/events` filters + `/api/v1/deliveries`; update `/openapi.json`.
8. **Docs:** add the `claude mcp add` snippet (and a tool list) to the relevant docs surface.
