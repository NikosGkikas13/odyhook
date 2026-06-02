# Odyhook — Architecture & Technology Decisions

This document explains the end-to-end flow of Odyhook and justifies every significant technology choice, including what alternatives were considered and why they were not selected.

---

## 1. What Odyhook Does

Odyhook is a webhook management platform. External services (Stripe, GitHub, Shopify, etc.) send HTTP POST requests to Odyhook, which verifies, stores, filters, optionally transforms, and reliably forwards them to one or more downstream destinations — with retries, observability, and AI-assisted tooling.

---

## 2. High-Level Architecture

```
                         ┌─────────────┐
  Provider (Stripe,      │  Next.js    │        ┌──────────┐
  GitHub, etc.)          │  App Server │───────>│ Postgres │
       │                 │             │        └──────────┘
       │  POST /api/     │  - Ingest   │
       │  ingest/:slug   │  - Dashboard│        ┌──────────┐
       └────────────────>│  - Auth     │───────>│  Redis   │
                         │  - Actions  │        └────┬─────┘
                         └─────────────┘             │
                                                     │ BullMQ
                         ┌─────────────┐             │
                         │   Worker    │<────────────┘
                         │  (separate  │
                         │   process)  │───> fetch(destination.url)
                         └─────────────┘
```

Two Node.js processes run side by side:
1. **Next.js server** — handles inbound webhooks, serves the dashboard UI, runs Server Actions.
2. **BullMQ worker** — polls Redis for delivery jobs, executes filter/transform/HTTP delivery logic.

They share Postgres (via Prisma) and Redis (via IORedis). This split lets the worker be scaled independently without competing with the web server's event loop.

---

## 3. Webhook Lifecycle (Data Flow)

### 3.1 Ingest (`POST /api/ingest/[slug]`)

1. **Source lookup** — Prisma query by unique `slug`. All enabled routes (with destinations) are included in a single query to avoid N+1.
2. **Rate limiting** — executed before reading the request body so we shed load before allocating memory for potentially large payloads. A Redis token-bucket check returns `allowed | rejected`. On rejection: `429 + Retry-After`.
3. **HMAC verification** — if the source has a signing secret and verify style configured, the encrypted secret is decrypted and the signature header is verified with constant-time comparison. Failure returns `401`.
4. **Persist** — a single Prisma nested write creates one `Event` row and one `Delivery` row per enabled route, all inside one transaction.
5. **Enqueue** — one BullMQ job per delivery is enqueued in parallel via `Promise.all`. Job payload is just `{ deliveryId }`.
6. **Respond** — `202 Accepted` with `eventId` and delivery count.

### 3.2 Delivery (Worker)

1. **Load delivery** with its Event and Destination from Postgres.
2. **Dedup guard** — skip if already `delivered` or `exhausted`.
3. **Filter** — if the Route has a `filterAst`, evaluate it deterministically against the parsed event body. If the filter rejects, mark the delivery as `delivered` with a `[skipped by filter]` note and stop.
4. **Mark in-flight** — update status and increment attempt count.
5. **Build headers** — strip hop-by-hop headers from the original request, decrypt and overlay destination static headers.
6. **Transform** — if a Transformation exists, execute the user's JS code inside QuickJS. On transform error, skip the HTTP call and fall into the retry path.
7. **HTTP delivery** — `fetch()` to the destination URL with an abort timeout (default 10s). Capture response code and first 2KB of body.
8. **Success** — mark `delivered`.
9. **Failure** — if attempts < 6, mark `failed`, compute exponential backoff delay (`10s → 30s → 2m → 10m → 1h → 6h`), set `nextRetryAt`, and re-enqueue with `{ delay }`. If attempts exhausted, mark `exhausted`.

---

## 4. Technology Choices & Justifications

### 4.1 Framework: Next.js (App Router)

**Chosen**: Next.js 16 with the App Router  
**Alternatives considered**: Express + separate React SPA, Fastify + React, Remix, SvelteKit

**Why Next.js won**:

- **Unified codebase** — a webhook platform needs both a public API endpoint (`/api/ingest/[slug]`) and a dashboard UI. Next.js serves both from the same project with shared types, shared Prisma client, and shared utility modules. With Express + React SPA, we'd need two separate projects, two builds, two deploy targets, and a contract layer (e.g., tRPC or OpenAPI) between them.
- **Server Components** — dashboard pages fetch data directly with Prisma inside the component, no client-side fetching, no loading waterfalls, no API routes just to serve the UI. The events page queries Postgres and renders HTML in a single server round-trip.
- **Server Actions** — form submissions (create source, toggle route, save transformation) call server functions directly without manually writing API routes, request validation, or fetch calls. This removed an entire layer of boilerplate.
- **Built-in middleware** — the `proxy.ts` file (v16's middleware) checks JWT auth at the edge before any dashboard route handler runs, without custom middleware wiring.

**Why not Express alone**: Express would work for the API side but offers nothing for the UI. We'd need to build and serve a React SPA separately, doubling the deployment surface and losing the ability to share code directly.

**Why not Remix**: Remix is a strong alternative for form-heavy UIs, but its data loading model (loaders/actions) doesn't provide as clean a story for the API-only ingest endpoint. Next.js route handlers are more natural for a "webhook receiver" use case.

### 4.2 Language: TypeScript

**Chosen**: TypeScript (strict mode)  
**Alternatives considered**: plain JavaScript, Go, Rust

**Why TypeScript won**:

- **Full-stack type safety** — Prisma generates typed models, Server Actions are typed functions, and the worker shares the same types as the API route. A typo in a field name is caught at compile time, not at 3 AM in production.
- **Ecosystem alignment** — Next.js, Prisma, BullMQ, NextAuth, and the Anthropic SDK are all TypeScript-first. Using Go or Rust for the worker would require a separate codebase, separate ORM, separate queue client, and a serialization contract between the two.
- **Developer velocity** — for a project of this scope, TypeScript offers the best balance of safety and speed. Go would be faster at runtime for the worker but slower to develop the dashboard. Rust would be even more so.

### 4.3 Database: PostgreSQL

**Chosen**: PostgreSQL 16  
**Alternatives considered**: MySQL, SQLite, MongoDB

**Why PostgreSQL won**:

- **JSON support** — webhook payloads are arbitrary JSON. Postgres has first-class `jsonb` operators, indexing (GIN), and querying. Event headers and filter ASTs are stored as `Json` columns and can be queried natively if needed. MongoDB also has good JSON support, but Postgres gives us relational integrity for the domain model (users, sources, routes, deliveries) alongside JSON flexibility for the payload data.
- **Prisma compatibility** — Prisma's strongest and most battle-tested adapter is PostgreSQL. Features like compound unique constraints (`@@unique([sourceId, destinationId])`), cascading deletes, and enum types all map cleanly.
- **Transactional guarantees** — the ingest endpoint creates an Event and multiple Deliveries in one atomic write. If any row fails, nothing is committed. This is critical: a half-written event with missing deliveries would silently drop webhooks.
- **Mature ecosystem** — extensions, monitoring, backups, and connection pooling are well-established. Scaling options like read replicas and pgBouncer are available when needed.

**Why not MongoDB**: The domain model is fundamentally relational (User → Source → Route → Destination). Modeling this in MongoDB would require either embedding (losing normalization) or manual reference management (losing the whole point of a document store). The JSON payloads are stored but rarely queried by structure — they're mostly opaque blobs that pass through.

**Why not SQLite**: No concurrent write support. The ingest endpoint and worker process both write frequently and simultaneously. SQLite's write lock would be a bottleneck immediately.

### 4.4 ORM: Prisma 7

**Chosen**: Prisma 7 with `@prisma/adapter-pg`  
**Alternatives considered**: Drizzle, Knex, TypeORM, raw SQL

**Why Prisma won**:

- **Schema-as-source-of-truth** — `schema.prisma` is a single file that defines every model, relation, index, and constraint. Migrations are generated automatically from schema diffs. This beats hand-writing migration files (Knex) or decorating entity classes (TypeORM).
- **Type generation** — `prisma generate` produces a fully typed client. `prisma.event.findMany({ include: { deliveries: true } })` returns `Event & { deliveries: Delivery[] }` with zero manual type wiring. This eliminated an entire category of runtime bugs.
- **Nested writes** — the ingest endpoint creates an Event with N Deliveries in one `prisma.event.create({ data: { ..., deliveries: { create: [...] } } })` call. Prisma wraps this in a transaction automatically.
- **Driver adapter** — Prisma 7's `@prisma/adapter-pg` lets us use a raw `pg` Pool directly, which gives full control over connection settings and avoids Prisma's legacy query engine binary.

**Why not Drizzle**: Drizzle is lighter-weight and closer to SQL, which is an advantage for complex queries. But for this project, most queries are straightforward CRUD with relations, and Prisma's nested write and include syntax is significantly more concise. Drizzle would require more manual join management.

**Why not raw SQL**: The schema has 12 interconnected models. Writing and maintaining raw SQL for all CRUD operations, migrations, and type mappings would be substantially more code with no practical benefit. Raw SQL is kept in reserve for performance-critical queries if they ever emerge (e.g., GIN-indexed full-text search).

### 4.5 Authentication: NextAuth v5 (Auth.js)

**Chosen**: NextAuth v5 with Nodemailer (magic-link email), JWT strategy  
**Alternatives considered**: Clerk, Auth0, Supabase Auth, custom JWT

**Why NextAuth won**:

- **Self-hosted** — webhook secrets and API keys pass through this system. Depending on a third-party auth service (Clerk, Auth0) for a security-sensitive tool adds an external dependency that could go down, change pricing, or introduce data residency concerns. NextAuth runs entirely within our infrastructure.
- **Passwordless by design** — magic-link email authentication has no passwords to hash, store, or leak. Users click a link in their email. This is appropriate for a developer tool where users already manage email access carefully.
- **JWT strategy for Edge** — the dashboard middleware (`proxy.ts`) runs on the Edge Runtime, which cannot access Prisma or a database. JWT sessions let the middleware verify auth by reading a signed cookie without any network call. This is why `auth.config.ts` (edge-safe, no adapter) is separate from `auth.ts` (full Node.js config with PrismaAdapter).
- **Prisma integration** — `@auth/prisma-adapter` maps NextAuth's User, Account, Session, and VerificationToken models directly into the existing Prisma schema. No separate user table management.

**Why not Clerk/Auth0**: Both are excellent for fast prototyping, but they introduce an external network dependency on every auth check. For a webhook platform that may handle high-throughput ingest, adding auth-provider latency to the middleware path is undesirable. They also move user data outside our control.

**Why not custom JWT**: Building JWT issuance, refresh, CSRF protection, and email verification from scratch is error-prone. NextAuth handles token rotation, secure cookie settings, and CSRF tokens out of the box.

### 4.6 Job Queue: BullMQ on Redis

**Chosen**: BullMQ 5 with IORedis  
**Alternatives considered**: PostgreSQL-based queue (pg-boss, SKIP LOCKED), RabbitMQ, AWS SQS, Inngest

**Why BullMQ won**:

- **Delayed jobs** — webhook retries need precise exponential backoff (`10s → 30s → 2m → 10m → 1h → 6h`). BullMQ's `{ delay: ms }` option handles this natively. Jobs sit in Redis with a scheduled execution time and are picked up when the delay expires. pg-boss supports this too, but BullMQ's implementation is more battle-tested at scale.
- **Redis is already required** — the rate limiter needs Redis for atomic Lua scripts. Since Redis is already in the infrastructure, adding BullMQ is zero additional infrastructure cost. Using a Postgres queue would work but adds write contention to the same database handling reads for the dashboard.
- **Concurrency control** — `new Worker(queue, handler, { concurrency: 8 })` limits parallel HTTP deliveries per worker process. This prevents a burst of webhooks from spawning thousands of concurrent fetch calls.
- **Visibility** — BullMQ stores job state in Redis, making it inspectable via tools like Bull Board or `redis-cli`. Failed jobs, their error messages, and retry counts are all queryable.

**Why not Postgres queue**: For moderate throughput, a Postgres-backed queue (SKIP LOCKED pattern) would work and avoid the Redis dependency. But since Redis is already required for rate limiting, there's no simplification. And under high write load, queue polling competes with dashboard read queries for Postgres connections.

**Why not RabbitMQ**: RabbitMQ is a dedicated message broker with stronger delivery guarantees (AMQP), but it's a heavyweight addition for a system that already has Redis. BullMQ on Redis is simpler to operate and sufficient for webhook delivery where "at least once with retries" is the correctness bar.

**Why not SQS/Inngest**: Both are managed services that simplify operations but introduce vendor lock-in and network latency. SQS's minimum delay granularity (seconds) works for our use case, but it requires AWS infrastructure. Inngest is a higher-level abstraction that could work well, but it moves queue management outside our control, which conflicts with the self-hosted philosophy.

### 4.7 Rate Limiting: Token-Bucket via Redis Lua

**Chosen**: Custom token-bucket implementation using a Redis Lua script  
**Alternatives considered**: `@upstash/ratelimit`, `rate-limiter-flexible`, fixed-window counter, Nginx rate limiting

**Why custom Lua script won**:

- **Atomicity** — the entire check-refill-decrement cycle runs as a single Lua script on the Redis server. There is no window between "check" and "decrement" where a concurrent request could sneak through. This eliminates the check-then-set race condition that plagues application-level implementations.
- **Token-bucket characteristics** — unlike a fixed window, a token bucket allows short bursts (up to the burst capacity) while enforcing a sustained rate. This matches webhook traffic patterns: providers like Stripe batch events and send them in bursts, so a pure fixed-window counter would reject legitimate traffic after a deploy or incident recovery.
- **Per-source configurability** — each source can override `rateLimitPerSec` and `rateLimitBurst` in the database. The `configForSource()` function merges DB overrides with env-var defaults. A high-volume source like Stripe can have `500/sec burst 1000`, while a low-volume internal service uses the default `10/sec burst 20`.
- **Fail-open** — if Redis is down, the rate limiter catches the error and allows the request through. This is a deliberate design choice: it's better to temporarily accept unmetered traffic than to reject all webhooks because of a Redis outage.

**Why not `@upstash/ratelimit`**: Designed for Upstash's serverless Redis, not standard Redis. We're already running our own Redis instance.

**Why not Nginx-level limiting**: Nginx can rate-limit by IP, but webhook providers send from shared IP pools. We need per-source (per-slug) limiting, which requires application-level logic.

### 4.8 Encryption: AES-256-GCM

**Chosen**: AES-256-GCM (authenticated encryption) with random IVs  
**Alternatives considered**: AES-256-CBC, libsodium secretbox, HashiCorp Vault, AWS KMS

**Why AES-256-GCM won**:

- **Authenticated encryption** — GCM produces an authentication tag alongside the ciphertext. If anyone tampers with the encrypted data in the database, decryption fails with an explicit error rather than silently returning garbage. CBC does not provide this — a padding oracle attack on CBC can recover plaintext without the key.
- **Node.js native** — `crypto.createCipheriv('aes-256-gcm', ...)` is built into Node.js with no additional dependencies. No native bindings, no WASM, no external service calls.
- **Envelope format** — each encrypted value is stored as `base64(IV || AuthTag || Ciphertext)`. The 12-byte IV is randomly generated per encryption, so encrypting the same secret twice produces different ciphertexts. This prevents an attacker who can see the database from determining whether two sources share the same signing secret.

**What is encrypted**: signing secrets (`Source.signingSecret`), destination static headers (`Destination.headersEnc`) which often contain bearer tokens, and user Anthropic API keys (`UserApiKey.anthropicKeyEnc`). These are the only secrets that must be recoverable (decrypted for use), unlike passwords which should be hashed.

**Why not Vault/KMS**: Both are excellent for key management at scale, but they add infrastructure complexity and network latency to every decrypt operation. The ingest endpoint decrypts the signing secret on every request — adding a Vault round-trip would increase latency. A single `ENCRYPTION_KEY` env var is appropriate for the current scale and can be migrated to Vault/KMS later if needed.

### 4.9 HMAC Verification: Multi-Style Support

**Chosen**: Three verification styles (Stripe, GitHub, generic-sha256) with constant-time comparison  
**Alternatives considered**: single generic HMAC, provider SDKs (e.g., `stripe.webhooks.constructEvent`)

**Why custom multi-style won**:

- **Provider-agnostic** — Odyhook is not tied to any single webhook provider. Stripe uses `Stripe-Signature: t=<ts>,v1=<hmac>`, GitHub uses `x-hub-signature-256: sha256=<hex>`, and most other services use a bare HMAC in a custom header. Supporting all three covers the vast majority of real-world webhook providers.
- **No SDK dependency per provider** — using `stripe.webhooks.constructEvent` would require installing the Stripe SDK (and every other provider's SDK). Our HMAC implementation is ~80 lines of code using only Node.js `crypto`. It verifies the same math without pulling in provider-specific dependencies.
- **Constant-time comparison** — all comparisons use `crypto.timingSafeEqual` to prevent timing oracle attacks. The hex strings are compared after ensuring equal length, which avoids a separate class of length-based timing leaks.

### 4.10 Transformation Sandbox: QuickJS (WASM)

**Chosen**: QuickJS compiled to WASM via `quickjs-emscripten`  
**Alternatives considered**: Node.js `vm` module, `isolated-vm`, Deno subprocesses, Lua sandbox, no code execution (JSONata/JMESPath)

**Why QuickJS-WASM won**:

- **True isolation** — QuickJS runs inside a WASM memory space that is completely separated from the Node.js host. There is no access to `process`, `require`, `fs`, `net`, or any Node.js API. Even if the user's code contains a prototype pollution or a `this.constructor.constructor('return process')()` escape, it affects only the WASM heap. Node.js `vm` contexts are explicitly documented as NOT a security mechanism — they share the same V8 isolate and can escape to the host.
- **Resource limits** — memory (16 MB), stack (256 KB), and CPU time (250ms wall-clock via interrupt handler) are all enforced. A malicious or buggy transformation cannot OOM the worker or spin forever. `isolated-vm` provides similar guarantees, but it's a native addon that requires compilation on each platform and has historically had compatibility issues with ARM (Apple Silicon).
- **JavaScript** — users write transforms in the same language as the rest of the codebase. Choosing Lua would force users to learn a different language for a small configuration task. JSONata/JMESPath are query languages, not general-purpose — they can select and restructure data but cannot add conditional logic, compute derived fields, or format strings.
- **No persistent state** — each invocation creates a fresh QuickJS runtime and context, then disposes both. There is no state leakage between transformation runs, no warm-up cache to invalidate, and no risk of one user's code affecting another.

**Why not `isolated-vm`**: It's a native C++ addon that must be compiled for each platform and Node.js version. This complicates deployment (especially on ARM/Docker) and creates maintenance burden around node-gyp and prebuild binaries. QuickJS-WASM is pure JavaScript with no native dependencies.

### 4.11 AI: Anthropic Claude (BYOK)

**Chosen**: Claude via `@anthropic-ai/sdk` with bring-your-own-key model  
**Alternatives considered**: OpenAI GPT-4, self-hosted LLM (Llama), built-in heuristics

**Why Claude won**:

- **Two-tier model strategy** — Claude Sonnet is used for tasks requiring reasoning quality (failure diagnosis, code generation, NL rule compilation, NL event-search compilation), while Claude Haiku is used for high-frequency structured tasks (schema drift detection, weekly digest). This maps cost to value: the diagnosis of a production outage justifies a Sonnet call, while summarizing weekly stats does not.
- **Structured output reliability** — the rule compiler asks Claude to output a specific JSON AST grammar. Claude's instruction-following is strong enough that the output passes `validateFilterAst()` validation consistently. The system prompt explicitly describes the 12-node grammar and includes domain hints (e.g., "Stripe amounts are in cents").
- **BYOK model** — users provide their own Anthropic API key, stored encrypted. This means Odyhook has zero AI infrastructure cost, no API key management complexity, and users maintain full control over their token spend. The alternative — Odyhook paying for API calls — would require usage-based pricing, billing infrastructure, and cost-per-user accounting.

**Why not OpenAI**: Both would work. Claude was chosen for the structured output and instruction-following characteristics needed by the rule compiler. The specific choice is swappable since AI calls are isolated behind `anthropicFor()` and model constants.

**Why not self-hosted**: Running a Llama instance adds GPU infrastructure, model serving complexity, and ongoing maintenance. The quality of code generation (transformations) and structured output (filter ASTs) from a 7B/13B model would be significantly lower, leading to more validation failures and worse user experience.

### 4.12 Testing: Vitest

**Chosen**: Vitest 4 with `@vitest/coverage-v8`  
**Alternatives considered**: Jest, Node.js built-in test runner, Playwright (for e2e)

**Why Vitest won**:

- **Native ESM and TypeScript** — Vitest understands TypeScript and ES modules natively. No `ts-jest` transformer, no `babel-jest`, no special configuration. The `vitest.config.ts` is 8 lines.
- **Same config ecosystem** — Vitest reuses the `resolve.alias` from the project's TypeScript config (`@/*` → `src/*`), so imports in tests work identically to imports in source code.
- **Speed** — Vitest uses esbuild for transformation, making individual test runs near-instant. The full 62-test suite (crypto, HMAC, filter evaluator) completes in under 2 seconds.

**Why not Jest**: Jest requires additional configuration for TypeScript (`ts-jest` or `@swc/jest`) and ESM (`experimental-vm-modules` flag). It's a heavier runtime with more configuration surface for no additional benefit in this context.

### 4.13 CSS: Tailwind CSS v4

**Chosen**: Tailwind CSS 4 with PostCSS  
**Alternatives considered**: CSS Modules, styled-components, vanilla CSS, shadcn/ui

**Why Tailwind won**:

- **Colocation** — styles live in the same file as the markup. For a dashboard with many small pages (sources list, events list, settings), jumping between `.module.css` files and components is unnecessary friction.
- **Consistency** — Tailwind's design tokens (spacing scale, color palette, font sizes) enforce visual consistency across pages without a custom design system.
- **No runtime** — unlike styled-components or Emotion, Tailwind generates static CSS at build time. There is no JavaScript runtime cost, which matters for Server Components where hydration payload size affects performance.

### 4.14 Infrastructure: Docker Compose

**Chosen**: Docker Compose with postgres:16-alpine, redis:7-alpine, mailhog  
**Alternatives considered**: local installs, Supabase local, cloud-hosted dev databases

**Why Docker Compose won**:

- **Reproducibility** — `docker compose up` gives every developer an identical Postgres, Redis, and mail server. No "works on my machine" from version mismatches or different Postgres configurations.
- **Isolation** — dev databases don't conflict with other projects. Named volumes (`odyhook_pg`, `odyhook_redis`) keep data separate.
- **MailHog** — captures magic-link emails during development without configuring a real SMTP server. The web UI at `localhost:8025` shows every email sent by NextAuth.

---

## 5. Key Design Decisions

### 5.1 Separate Worker Process

The delivery worker runs as a standalone Node.js process (`tsx src/workers/delivery.ts`), not inside the Next.js server.

**Why**: Webhook delivery involves long-running HTTP calls (up to 10s timeout per attempt), retry scheduling, and potentially CPU-intensive QuickJS transformation execution. Running this inside the Next.js server would compete with request handling for the event loop, increasing response latency for both the ingest endpoint and the dashboard. A separate process can be scaled horizontally (multiple worker instances with different concurrency) independently of the web server.

### 5.2 Compile-Once, Evaluate-Many Filters

The NL rule compiler calls Claude once to produce a deterministic JSON AST. The AST is stored in the database and evaluated at delivery time with zero LLM cost.

**Why**: Calling an LLM on every webhook delivery would add latency (~1-3s), cost ($0.003+ per call), and a failure mode (API outage blocks all deliveries). By compiling the rule once to a deterministic AST, evaluation is instant (~0.01ms), free, and has no external dependency. The AST evaluator is a pure function with no I/O.

### 5.3 Cursor-Based Pagination

The events page uses keyset cursor pagination (`ORDER BY receivedAt DESC, id DESC` with `cursor: { id }, skip: 1`) instead of offset pagination.

**Why**: Webhook events arrive continuously. With offset pagination, new events shift existing ones to the next page while the user is browsing, causing duplicates and missing entries. Cursor pagination is stable: "show me everything older than this event" always returns the same set regardless of new arrivals.

### 5.4 Rate Limiting Before Body Read

The ingest endpoint checks the rate limit before calling `req.text()`.

**Why**: Reading the body allocates memory proportional to the payload size. A burst of large payloads (e.g., 1MB each) from a single source could exhaust memory before we even check if the source is over its limit. By checking the rate limit first — a single Redis round-trip with microsecond latency — we reject excess traffic before allocating any body memory.

### 5.5 Fail-Open Rate Limiter

If the Redis rate limit check throws an error, the request proceeds as if it were allowed.

**Why**: The rate limiter exists to protect against accidental bursts, not as a security gate. If Redis is temporarily unreachable, rejecting all webhooks would cause data loss. Failing open means we temporarily accept unmetered traffic during a Redis outage, which is recoverable. Failing closed during an outage would mean permanently lost webhooks, which is not.

### 5.6 Privacy-Preserving AI Diagnosis

The failure diagnosis sends only structural information to Claude: the destination host (not the full URL), safe headers only (`content-type`, `user-agent`, `accept`), and a structural fingerprint of the payload (key names and value types, not actual values).

**Why**: Webhook payloads often contain customer PII, payment details, or internal identifiers. Sending raw payloads to an external LLM would be a data leak. The structural fingerprint (`{ "data": { "object": { "id": "string", "amount": "number" } } }`) gives Claude enough context to diagnose most issues (wrong content-type, missing fields, schema mismatch) without exposing actual data.

---

## 6. Runtime Dependencies Summary

| Component | Technology | Why This One |
|---|---|---|
| Framework | Next.js 16 (App Router) | Unified API + UI, Server Components, Server Actions |
| Language | TypeScript (strict) | Full-stack type safety across Prisma, API, UI, worker |
| Database | PostgreSQL 16 | Relational integrity + JSON flexibility, transactional writes |
| ORM | Prisma 7 | Schema-driven, typed client, nested writes, auto-migrations |
| Auth | NextAuth v5 (magic-link) | Self-hosted, passwordless, JWT for Edge middleware |
| Queue | BullMQ on Redis | Delayed jobs for retry backoff, concurrency control |
| Cache/Limiter | Redis 7 | Shared by queue + rate limiter, atomic Lua scripts |
| AI | Claude (Sonnet + Haiku) | Two-tier model for cost/quality, BYOK eliminates infra cost |
| Sandbox | QuickJS (WASM) | True process isolation, resource limits, no native deps |
| Encryption | AES-256-GCM (Node crypto) | Authenticated encryption, random IVs, zero dependencies |
| Testing | Vitest 4 | Native TS/ESM, fast, minimal config |
| CSS | Tailwind CSS 4 | Colocated styles, design tokens, no JS runtime |
| Dev infra | Docker Compose | Reproducible Postgres + Redis + MailHog |
