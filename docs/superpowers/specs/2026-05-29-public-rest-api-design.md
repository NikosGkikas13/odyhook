# Public REST API (`/api/v1`) — Design

**Date:** 2026-05-29
**Status:** Approved (design phase)
**Feature ref:** Gap analysis #8 (Tier 2) — see `~/.claude/plans/ok-as-you-can-concurrent-engelbart.md`

## Goal

Give Odyhook a versioned, key-authenticated REST API for **full programmatic
management** of webhook routing — so users can script their setup, manage it
Terraform-style, and (later) so the `odyhook listen` CLI (#9) has an
authenticated surface to build on.

Today the only HTTP endpoints are ingest, auth, and event replay/bulk-ops.
Every other mutation (create source, wire destination, define route) happens
through **Next.js Server Actions** in `src/lib/actions/` — a private,
session-cookie-authed, framework-internal mechanism with no stable contract.
The API exposes the same capabilities to non-browser callers.

## Scope

**In:**
- Full CRUD on the config resources: **sources, destinations, routes**.
- **Read-only** access to **events** (list + get) and their **deliveries**
  (events are authored by providers via ingest, not by this API; replay already
  has its own endpoint).
- A new `ApiToken` model (hashed, GitHub-PAT style) + token management UI.
- Per-token rate limiting, cursor pagination, an OpenAPI spec, Vitest tests.

**Out (deliberately deferred):**
- The `/api` public docs page and SDK generation (Tier 3.5) — though the
  OpenAPI spec we write here is the input for them.
- The CLI itself (#9) — this API is its prerequisite.
- Creating/mutating events or deliveries via the API.

## Architectural decision: shared service layer (Approach A)

The create/update/delete logic (Zod validation, slug generation, secret
encryption) currently lives **inside** the Server Actions, which are
session-authed and take `FormData`. The API needs the same logic with token
auth and JSON bodies.

**Chosen:** extract the core logic into a pure **service layer**. Both the
existing Server Actions and the new API handlers call it. This is the single
source of truth — the UI and API can never drift. The alternative (duplicating
logic in the handlers) was rejected because it guarantees divergence over time.

- `src/lib/services/{sources,destinations,routes}.ts` — pure functions
  `(userId, input) => result` owning validation + encryption + Prisma writes.
- Existing `src/lib/actions/*.ts` become thin wrappers: parse `FormData` →
  call service → `revalidatePath`. Logic moves verbatim; low risk.
- Read helpers (`listEvents`, `getEvent`, `listSources`, …) live alongside.

## 1. Data model — `ApiToken`

```prisma
model ApiToken {
  id         String    @id @default(cuid())
  userId     String
  name       String    // human label: "my-laptop", "terraform"
  tokenHash  String    @unique  // sha256(raw token), hex
  prefix     String    // first chars shown in UI: "ody_a1b2…"
  lastUsedAt DateTime?
  revokedAt  DateTime?
  createdAt  DateTime  @default(now())

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@index([userId])
}
```

- Add `apiTokens ApiToken[]` to `User`.
- Raw token format: `ody_` + 32 random bytes base64url. Shown **once** at
  creation; we persist only `sha256(raw)`.
- We **hash, not encrypt** (unlike `crypto.ts`, which is reversible AES-256-GCM
  for secrets we must recover) because we only ever *verify* a presented token,
  never recover it.
- `prefix` lets the UI list tokens recognizably without storing the secret.
- Prisma migration via `npm run db:migrate`.

## 2. Authentication

`src/lib/api/authenticate.ts` → `authenticateApiToken(req): Promise<{ userId } | null>`:

1. Read `Authorization: Bearer ody_…`. Missing/malformed → `null`.
2. `sha256` the presented token; look up `ApiToken` by `tokenHash`.
3. Reject (`null`) if not found or `revokedAt` is set.
4. Fire-and-forget `lastUsedAt = now()` update (don't block the request).
5. Return `{ userId }`.

Handlers return `401` on `null`. **Every** DB query is scoped by `userId`
(same ownership pattern as the existing bulk routes), so a token can only ever
touch its owner's data.

## 3. Route surface

Next file-based routing, each handler `export const runtime = "nodejs"`,
`NextResponse.json`, Next 16 `params: Promise<{ id }>`.

| Path | Methods |
|---|---|
| `src/app/api/v1/sources/route.ts` | `GET` (list), `POST` (create) |
| `src/app/api/v1/sources/[id]/route.ts` | `GET`, `PATCH`, `DELETE` |
| `src/app/api/v1/destinations/route.ts` | `GET`, `POST` |
| `src/app/api/v1/destinations/[id]/route.ts` | `GET`, `PATCH`, `DELETE` |
| `src/app/api/v1/routes/route.ts` | `GET`, `POST` |
| `src/app/api/v1/routes/[id]/route.ts` | `GET`, `PATCH`, `DELETE` |
| `src/app/api/v1/events/route.ts` | `GET` (list, paginated) |
| `src/app/api/v1/events/[id]/route.ts` | `GET` (includes deliveries) |

**Write-only secrets:** `signingSecret`, `outboundSecretEnc`, `headersEnc` are
accepted on create/update but **never returned**. Responses expose booleans
(e.g. `hasSigningSecret`, `hasOutboundSecret`) instead.

## 4. Conventions

- **Error shape:** `{ "error": { "code": "...", "message": "..." } }`.
  Codes: `unauthorized` (401), `not_found` (404), `validation_error` (400,
  with field details), `rate_limited` (429), `conflict` (409 — e.g. a duplicate
  `(sourceId, destinationId)` route, which the schema's `@@unique` enforces).
- **Pagination:** list endpoints accept `?limit=` (default 25, max 100) and
  `?cursor=` (opaque — the last returned id). Response:
  `{ data: [...], nextCursor: string | null }`. Events cursor on
  `(receivedAt, id)` to match the existing `@@index([sourceId, receivedAt])`.
- **Rate limiting:** reuse the Redis token-bucket (`src/lib/ratelimit.ts`),
  new key `rl:api:<tokenId>`, env `API_RATE_LIMIT_PER_SEC` /
  `API_RATE_LIMIT_BURST`. On rejection: `429` + `Retry-After` header. **Fails
  open** on Redis error, matching existing endpoints.

## 5. Token management UI

`src/app/(dashboard)/settings/api-tokens/page.tsx` +
`src/lib/actions/api-tokens.ts` (session-authed Server Actions):

- **List:** name, prefix, last used, created, revoked state.
- **Create:** prompts for a name; shows the raw token **once** in a copy-box
  with a "you won't be able to see this again" warning.
- **Revoke:** sets `revokedAt`.
- Linked from the settings nav alongside the existing API Keys (Anthropic) page.

This is the only bootstrap path — a user can't authenticate to the API before
minting a token, and minting requires a logged-in session.

## 6. OpenAPI spec

Hand-written spec (`src/app/api/v1/openapi.json` served via a route, or a
static `public/openapi.json`) describing all endpoints, the bearer scheme, and
request/response schemas. Consumed later by the `/api` docs page and any SDK
generation. Kept in sync manually for now.

## 7. Tests (Vitest)

Mirror the repo's existing Vitest style; import handlers directly (no live
server). Coverage:

- **Auth:** missing / malformed / unknown / revoked token → `401`.
- **Ownership:** token for user A cannot read or mutate user B's resources.
- **CRUD happy paths** for sources, destinations, routes.
- **Read paths:** events list + get (with deliveries).
- **Pagination:** cursor returns the next page; `nextCursor` null at the end.
- **Rate limit:** exceeding the bucket → `429` with `Retry-After`.
- **Service layer:** unit tests for validation + secret write-only behavior.

## Build sequence

1. `ApiToken` model + Prisma migration.
2. Service-layer extraction (Server Actions refactored to wrappers; UI keeps
   working — verify before moving on).
3. `authenticateApiToken` helper.
4. Route handlers (sources → destinations → routes → events).
5. Pagination + per-token rate limiting.
6. Token management UI + Server Actions.
7. OpenAPI spec.
8. Tests.

## Verification

Per the gap-analysis plan's verification notes:
- Dev env: `docker compose up -d` (pg/redis/mailhog), `npm run dev`.
- Mint a token in the UI, then exercise the API with `curl`:
  `curl -H "Authorization: Bearer ody_…" http://localhost:3000/api/v1/sources`.
- Confirm CRUD round-trips appear in the dashboard; confirm a second user's
  token gets `404`/`401` on the first user's resources.
- Run the Vitest suite.

## Out of scope / non-goals

- Multiple environments, event/delivery mutation, SDKs, the docs site, the CLI.
- Enterprise auth (OAuth scopes, fine-grained permissions) — tokens are
  full-access to their owner's account for now.
