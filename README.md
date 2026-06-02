# Odyhook

Smart webhook proxy: ingest every webhook, log it forever, forward to
destinations with automatic retries, and replay any event with one click.

Built with Next.js 16, Prisma 7 (postgres driver adapter), NextAuth v5,
BullMQ/Redis, Tailwind v4.

## First-time setup

```bash
# 1. Install deps (prisma generate runs automatically)
npm install

# 2. Copy env and fill in real secrets
cp .env.example .env
# Generate AUTH_SECRET and ENCRYPTION_KEY (must decode to 32 bytes):
openssl rand -base64 32   # paste into AUTH_SECRET
openssl rand -base64 32   # paste into ENCRYPTION_KEY

# 3. Boot local infra (Postgres + Redis + MailHog for magic-link emails)
docker compose up -d

# 4. Apply the Prisma schema to the database
npm run db:migrate
```

## Running it

Odyhook needs **two processes** running side-by-side:

```bash
# Terminal A — Next.js app (dashboard + ingest + auth)
npm run dev

# Terminal B — delivery worker (retries, BullMQ consumer)
npm run worker
```

Then:

1. Open <http://localhost:3000> and click **Sign in**
2. Enter any email — MailHog captures the magic link at <http://localhost:8025>
3. Click the link in MailHog to finish sign-in
4. Create a **Source** (copy its ingest URL)
5. Create a **Destination** (try `https://webhook.site/<your-uuid>`)
6. On **Routes**, toggle the source → destination pair on
7. Send a test event:

   ```bash
   curl -X POST http://localhost:3000/api/ingest/<source-slug> \
     -H "Content-Type: application/json" \
     -d '{"type":"charge.succeeded","data":{"amount":2500}}'
   ```

8. Open **Events** → the event appears; click it → delivery timeline shows the
   forwarded request. Click **Replay** to resend.

## MCP server

Odyhook exposes its sources, destinations, routes, events, and deliveries as MCP
tools at `/api/mcp`, authenticated with an API token (Settings → API Tokens):

```bash
claude mcp add --transport http odyhook https://odyhook.dev/api/mcp \
  --header "Authorization: Bearer ody_…"
```

(Use `http://localhost:3000/api/mcp` against a local dev server.) Then ask your
agent things like *"show me failed deliveries for my Stripe source"* or *"create
a route from gh-prod to slack-alerts filtering for pushes to main"*.

Reads cover sources/destinations/routes/events/deliveries; safe writes cover
create/update + pause/resume + route filters. Two BYOK tools need your Anthropic
key: `compile_filter` turns plain English into a filter AST, and `search_events`
runs a natural-language search across event metadata and payload content. There
are no destructive (delete) tools. The endpoint is a stateless Streamable-HTTP
server — see `src/lib/mcp/` (tool registry + dispatch) and `src/app/api/mcp/route.ts`.

## Project layout

```
prisma/schema.prisma              – User, Source, Destination, Route, Event, Delivery
src/auth.config.ts                – edge-safe NextAuth config (proxy + authorized)
src/auth.ts                       – full NextAuth with Prisma adapter + Email provider
src/proxy.ts                      – Next 16 proxy (route protection for /sources, /events, …)
src/lib/prisma.ts                 – Prisma 7 client via @prisma/adapter-pg
src/lib/crypto.ts                 – AES-256-GCM for destination headers + signing secrets
src/lib/hmac.ts                   – Stripe / GitHub / generic SHA-256 signature verify
src/lib/queue.ts                  – BullMQ queue + lazy Redis connection + backoff schedule
src/lib/actions/{sources,destinations,routes}.ts – server actions for CRUD
src/workers/delivery.ts           – delivery worker process (runs via `npm run worker`)
src/app/api/ingest/[slug]/route.ts        – public ingest endpoint
src/app/api/events/[id]/replay/route.ts   – manual replay
src/app/(dashboard)/               – sources, events, destinations, routes pages
src/app/signin/                    – magic-link sign-in page
docker-compose.yml                – Postgres + Redis + MailHog
```

## Retry schedule

Failed deliveries are retried with exponential backoff (6 attempts total):

```
10s → 30s → 2m → 10m → 1h → 6h → exhausted
```

Configurable in `src/lib/queue.ts` (`RETRY_DELAYS_MS`).

## Forcing failures to test retries

Point a destination at `https://httpbin.org/status/500` and send an event —
the worker logs will show the backoff schedule, and the event detail page
will show each failed attempt in the delivery timeline..
