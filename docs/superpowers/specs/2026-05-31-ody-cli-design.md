# `ody` CLI — Design

> Status: approved design (2026-05-31). Implements wishlist item **#9 (CLI for local
> development)** from the competitor gap analysis. Unblocked by the public REST API +
> API-token auth shipped in PR #5.

## Context & goal

Odyhook is a self-hosted webhook router: providers POST webhooks to
`https://<instance>/api/ingest/<slug>`, the app verifies + persists them, and a worker
forwards to downstream destinations with retries.

The CLI turns Odyhook into a **daily-driver dev tool**, not just a prod router. Its core
loop mirrors ngrok / Hookdeck `listen` / Svix `listen`: the server pushes new events for
a source to a connected CLI, which re-POSTs each to a local URL (e.g.
`http://localhost:3000/webhook`). This is the single highest-leverage feature in the
roadmap because it changes how the product gets used day to day.

This is the **full toolkit** scope: live forward + backlog replay + `trigger` test events.
AI-generated fixtures (wishlist #10) are explicitly **out of scope** here.

## Foundation it builds on (already shipped)

- **Auth:** `ody_`-prefixed bearer tokens (`ApiToken` model), validated by
  `src/lib/api/authenticate.ts`. The CLI reuses this path untouched.
- **Event fidelity:** an `Event` row stores `method`, `headersJson`, and `bodyRaw` (raw
  request body as text) — everything needed to replay a webhook byte-for-byte.
- **API conventions:** `src/lib/api/handler.ts#withApiAuth` centralizes 401/429 + error
  mapping; `src/lib/api/respond.ts` has cursor pagination helpers.
- **Redis:** `ioredis` is already a dependency (BullMQ + rate limiting), so Redis pub/sub
  is available with no new infra.

## Commands

| Command | Purpose |
|---|---|
| `ody login` | Prompt for instance host + API token; persist to a config file. |
| `ody listen --source <slug> --forward <url> [--since <duration>]` | Stream live events from a source and re-POST each to a local URL. |
| `ody trigger <slug> --data @file.json \| --data - [--header K:V]...` | Send a payload (file/stdin) into a source's ingest URL. |
| `ody trigger <slug> --replay <eventId>` | Re-send a past event's stored body+headers into the source. |

`events list/tail` is intentionally **not** included: `/api/v1/events` already lists, and
live tailing is exactly what `listen` does.

## Packaging

- Command name **`ody`** (matches the `ody_` token prefix).
- Lives in-repo at `cli/` with its **own** `package.json` and `tsconfig.json`, built
  independently of the Next app. Written in TypeScript.
- Dev: run via `tsx`. Distribution: published to npm as `@odyhook/cli`
  (`npm i -g @odyhook/cli`), `bin: { "ody": "./dist/index.js" }`.
- Tests: Vitest (matching the repo).

## Config & auth

Because Odyhook is self-hosted, the CLI must be pointed at the user's own instance.

- `ody login` interactively prompts for:
  - **host URL** (e.g. `https://odyhook.dev` or a user's own domain),
  - **API token** (`ody_…`, minted at Settings → API Tokens).
- Persisted to `~/.config/odyhook/config.json`, file mode `600`, shape:
  `{ "host": "https://…", "token": "ody_…" }`.
- Env vars `ODYHOOK_HOST` / `ODYHOOK_TOKEN` override the config file (for CI / scripting).
- Every request sends `Authorization: Bearer ody_…`.

## Live transport (server side)

Two server-side additions:

### Publish on ingest
After `src/app/api/ingest/[slug]/route.ts` persists an `Event`, publish a message to a
Redis channel `events:<sourceId>` via the existing `ioredis` connection. The message
carries the fields the CLI needs to forward: `id`, `method`, `headersJson`, `bodyRaw`,
`receivedAt`. Fire-and-forget — a publish failure must never affect ingest success.

### `GET /api/v1/listen?source=<slug>` — SSE endpoint
- Wrapped in `withApiAuth` (token auth + rate limit reuse).
- Verifies the authenticated user **owns** the requested source (404/own-scope check).
- Subscribes to Redis channel `events:<sourceId>` and streams each event as an SSE frame:
  - `id:` = the event id (enables `Last-Event-ID` reconnect),
  - `data:` = JSON `{ id, method, headersJson, bodyRaw, receivedAt }`.
- **Reconnect backfill:** when the client reconnects with a `Last-Event-ID` header, the
  server first queries Postgres for events on that source newer than the given id and
  emits them before resuming the live subscription. This closes the
  "missed while disconnected" gap automatically (correctness, not opt-in).
- Sends periodic heartbeat comments (`: ping`) to keep the connection alive through Caddy.
- Pushing the full body over SSE avoids a second round-trip per event.

Ordering is preserved per source (single subscription, sequential emit).

## CLI `listen` loop

1. Resolve host+token from config/env.
2. If `--since <duration>` (e.g. `1h`, `30m`) is given, backfill recent history at
   startup before going live (the explicit "backlog replay" piece). Implemented by paging
   `/api/v1/events` filtered to the source and replaying matching events through the same
   forward path, oldest-first.
3. Open the SSE stream to `/api/v1/listen?source=<slug>`.
4. For each event, **re-POST to `--forward <url>`**:
   - method = the event's original method,
   - headers = the event's original headers, **minus hop-by-hop headers** (`host`,
     `content-length`, `connection`, `transfer-encoding`, etc.) which are recomputed by
     the HTTP client,
   - body = `bodyRaw` verbatim.
   So the local app receives the provider's method/body and headers. **Caveat:** ingest
   redacts credential + signature headers (`stripe-signature`, `x-hub-signature-256`, …)
   before persisting, so those arrive `[redacted]` — local HMAC signature verification
   must be disabled for the forward target.
5. Print one status line per event, e.g. `✓ 200  42ms  evt_abc` / `✗ ECONNREFUSED evt_abc`.
6. A failed local POST is logged but **does not** stop the stream.
7. Events forwarded **sequentially** to preserve order.
8. On disconnect, reconnect with exponential backoff, resuming from the last seen event id
   (via `Last-Event-ID`).

MVP listens to a **single** source per invocation. Multiplexing multiple `--source` flags
is a possible later extension, not in this plan.

## `ody trigger`

No new "send" infra — it POSTs to the existing ingest URL.

- `--data @file.json` (or `--data -` for stdin) POSTs the payload to
  `<host>/api/ingest/<slug>` with optional repeatable `--header K:V` flags. Prints the
  ingest response (status + event id if returned).
- `--replay <eventId>` fetches the stored event's `bodyRaw` + `headersJson` and re-POSTs
  it to the source's ingest URL. `GET /api/v1/events/<id>` already returns `bodyRaw` and
  `method` (via `EventDetailDTO`) but the DTO currently **omits `headersJson`** — so this
  task must add `headersJson` to `EventDetailDTO`/`getEvent` so replay can reproduce the
  original headers.
  - **Replay creates a NEW event.** Idempotency may dedupe an identical body (per the
    `@@unique([sourceId, idempotencyKey])` constraint) — this is acceptable and will be
    documented in the command's help text. Replay does **not** bypass dedupe.

## Error handling

- Missing/invalid config → clear "run `ody login` first" message, non-zero exit.
- 401 from the API → "token rejected; re-run `ody login`".
- 429 → respect `Retry-After` and back off.
- Unknown/unowned source slug → "source not found" (mirrors API 404).
- Local forward target down → per-event error line, stream continues.
- SSE disconnect → reconnect with backoff; never crash on transient network errors.

## Testing strategy

Unit tests (no network) for the pure pieces:
- config load/save + env override precedence,
- hop-by-hop header filtering,
- SSE frame parse/serialize,
- forward-request construction (method/headers/body fidelity),
- `--since` duration parsing.

Integration tests:
- `listen` against a stub SSE server + a local sink (assert the sink receives the exact
  method/headers/body),
- reconnect resumes from `Last-Event-ID`,
- `trigger --data` and `trigger --replay` against a stub ingest endpoint.

## Build sequence

1. CLI scaffold (`cli/` package, arg parsing, `ody login` + config store).
2. Server: publish-on-ingest + `GET /api/v1/listen` SSE endpoint.
3. `ody listen` live-forward — **the end-to-end spine**; verify a real webhook reaches
   localhost.
4. `--since` backlog replay at startup.
5. `ody trigger --data` (file/stdin).
6. `ody trigger --replay <eventId>`.
7. Docs: README usage + an `infra/README.md` note on the new SSE endpoint.

## Out of scope (deferred to future plans)

- AI-generated test fixtures (wishlist #10).
- Built-in canned provider payload templates for `trigger`.
- Routed/transformed forwarding (CLI receives raw source events only).
- Multiplexing multiple sources in one `ody listen`.
- `events list/tail` subcommands.
