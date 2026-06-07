# Odyhook — Infrastructure & Operations

The operational ground truth for the project. Updated whenever infra changes. For *app* architecture and tech-choice rationale see [ARCHITECTURE.md](../ARCHITECTURE.md); for the deeper "why we deployed this way" narrative see [hetzner.md](../hetzner.md); for recovery procedures see [recovery.md](recovery.md).

---

## At a glance

**Odyhook** is a self-hosted webhook router: receives webhooks from external providers (Stripe, GitHub, etc.), verifies signatures, persists them, optionally transforms/filters, and reliably forwards to downstream destinations with retries.

| | |
|---|---|
| Production URL | `https://odyhook.dev` (apex), `www` → apex 301 redirect |
| Server | Hetzner Cloud CX23, Helsinki — `157.180.91.106` (2 vCPU, 4 GB RAM, 40 GB SSD) |
| Hosting cost | €4.95/month |
| Source repo | `github.com/NikosGkikas13/odyhook` (public) |
| Compose project name | `hooksmith` (derived from the `/opt/hooksmith` directory basename; kept after the Odyhook rebrand to avoid a `pg_dump` migration of named volumes) |
| Container image tag | `odyhook-app:latest` (built locally on the server from the repo's Dockerfile) |
| Repo on server | `/opt/hooksmith` (single canonical checkout — `~/hooksmith` was removed) |

---

## What this project is (one-paragraph version)

External providers POST webhooks to `https://odyhook.dev/api/ingest/<slug>`. The Next.js app verifies the HMAC signature (Stripe / GitHub / generic-sha256), rate-limits via a Redis token bucket, persists an `Event` + one `Delivery` row per enabled route in a single Postgres transaction, then enqueues BullMQ jobs. A separate **worker** process pulls those jobs from Redis, applies route filters and optional QuickJS transformations, and `fetch()`s to each destination with retries (exponential backoff: 10s → 30s → 2m → 10m → 1h → 6h). Caddy fronts everything for TLS. Magic-link auth via Resend SMTP; GitHub OAuth as alternative. Users bring their own Anthropic API keys for AI-assisted filter compilation and failure diagnosis (encrypted at rest). A public REST API is live at `/api/v1` (authenticated by API tokens minted at Settings → API Tokens); the OpenAPI spec is served at `/openapi.json`. A public, signed-out marketing & docs site lives under the `(marketing)` route group: `/docs` (14 pages — quickstart, signature verification, outbound HMAC, retries & backoff, rate limits, idempotency, CLI, REST API, an OpenAPI-rendered API reference, MCP, AI filters/transforms, NL event search, AI event diffs, plus the index), `/pricing`, `/use-cases`, `/changelog`, and competitor comparison pages at `/vs/hookdeck` and `/vs/svix`. The `/docs/api-reference` page is rendered statically from `public/openapi.json` via `src/lib/openapi/`.

Five running containers in production. Three external services (Resend, Cloudflare R2, Sentry). One cron file. Everything deployed via GitHub Actions on push to `main`.

Notable endpoints beyond the ingest path:

- **`GET /api/v1/listen?source=<slug>`** is a Server-Sent Events stream consumed by the `ody`
  CLI (in `cli/`). Ingest publishes each persisted event to a Redis channel `events:<sourceId>`;
  this endpoint subscribes and streams events to connected CLIs, backfilling events missed
  while disconnected via the `Last-Event-ID` header on reconnect. Caddy must pass it through
  unbuffered (the response sets `X-Accel-Buffering: no`).

- **`POST /api/v1/fixtures`** generates a realistic test payload from a plain-English
  description for the `ody trigger --generate` command. It runs server-side using the
  authenticated user's BYOK Anthropic key (`anthropicFor`), grounded on up to 5 recent
  events for the source. It generates only — the CLI delivers the result through the normal
  `/api/ingest/<slug>` path.

- **`POST /api/v1/events/search`** runs a natural-language event search. It compiles the
  English (BYOK Anthropic key) into a structured query, then executes it: source/time/
  delivery-status become a Postgres `WHERE`, while payload-content predicates are evaluated
  in-memory against `Event.bodyRaw` (stored as text, not JSONB) up to a scan cap, with
  resumable cursor pagination. API-token auth; returns the compiled query + matching events.
  The dashboard `/events` search box and the `search_events` MCP tool share the same engine
  — see `src/lib/search/` and `src/lib/ai/search-compiler.ts`.

- **`POST /api/mcp`** is the Model Context Protocol (Streamable HTTP) endpoint for
  coding agents (e.g. Claude Code). It authenticates with an `ody_` API token (same
  tokens as `/api/v1`) and exposes the read + safe-write tool surface over the existing
  service layer — including the BYOK `compile_filter` and `search_events` (natural-language
  event search) tools — see `src/lib/mcp/` (tool registry + JSON-RPC dispatch) and
  `src/app/api/mcp/route.ts`. Stateless; no session store. No destructive (delete) tools.

---

## Tech stack (production)

| Layer | Choice | Pinned version |
|---|---|---|
| Web framework | Next.js (App Router) | `16.2.3` |
| Language | TypeScript (strict) | `5.x` |
| ORM | Prisma 7 with `@prisma/adapter-pg` | `7.7.0` |
| DB | PostgreSQL | `16-alpine` (Docker) |
| Cache + Queue | Redis | `7-alpine` (Docker) |
| Queue library | BullMQ | `5.x` |
| Auth | NextAuth v5 (magic-link + GitHub OAuth) | `5.0.0-beta.30` |
| HMAC | Node `crypto` (built-in) | n/a |
| Encryption at rest | AES-256-GCM (Node `crypto`) | n/a |
| Transformation sandbox | QuickJS via `quickjs-emscripten` (WASM) | `0.32.x` |
| AI | Anthropic Claude (BYOK) | `@anthropic-ai/sdk` `0.87.x` |
| TLS / reverse proxy | Caddy 2 | `2-alpine` (Docker) |
| Container runtime | Docker | host-installed via `get.docker.com` |
| Orchestration | Docker Compose v2 | `docker compose` (no hyphen) |
| Observability | Sentry (web + worker) | `@sentry/nextjs` `10.53.x` |
| Backups | `pg_dump` → `rclone` → Cloudflare R2 | rclone v1.74.x |
| Tests | Vitest 4 | n/a in prod |
| CSS | Tailwind 4 | n/a in prod |

ARCHITECTURE.md explains *why* each one of these was picked.

---

## Repo structure (operationally significant files)

```
.
├── .github/workflows/deploy.yml   # GitHub Actions auto-deploy on push to main
├── docker-compose.yml             # LOCAL DEV: postgres + redis + MailHog
├── docker-compose.prod.yml        # PROD: postgres + redis + web + worker + caddy
├── Dockerfile                     # Multi-stage build for web + worker (same image)
├── Caddyfile                      # Production HTTPS config for odyhook.dev
├── next.config.ts                 # Wrapped with withSentryConfig()
├── prisma.config.ts               # Prisma 7 config — reads DATABASE_URL
├── prisma/schema.prisma           # 12-model schema; output → src/generated/prisma
├── src/instrumentation.ts         # Sentry registration (server + edge runtimes)
├── src/sentry.server.config.ts    # Sentry init for Node runtime
├── src/sentry.edge.config.ts      # Sentry init for Edge runtime
├── src/workers/delivery.ts        # BullMQ delivery worker process (init Sentry inline)
├── src/auth.ts                    # Full NextAuth config with PrismaAdapter
├── src/auth.config.ts             # Edge-safe NextAuth config (used by proxy.ts)
├── src/proxy.ts                   # Next 16 middleware — JWT-only route gate
├── src/scripts/digest.ts          # Weekly digest cron job
├── src/scripts/drift.ts           # Daily drift check cron job
├── .env                           # GITIGNORED — only on server. See "Environment vars" below
├── ARCHITECTURE.md                # Why each tech choice
├── DEPLOY.md                      # Older deployment doc (covers Fly.io + VPS paths)
├── hetzner.md                     # Conceptual companion to the VPS deploy
└── infra/                         # This folder
    ├── README.md                  # ← you are here
    └── recovery.md                # Disaster-recovery procedures
```

---

## Production architecture

```
                                  ┌──────────────┐
   Internet ──TLS:443──────────▶  │    Caddy     │
                                  │ (Let's       │
                                  │  Encrypt,    │
                                  │  auto-renew) │
                                  └──────┬───────┘
                                         │ HTTP :3000 (Docker network)
                                         ▼
                                  ┌──────────────┐         ┌──────────────┐
                                  │ web          │────────▶│  Postgres    │
                                  │ (Next.js 16) │         │  (named vol) │
                                  │              │         └──────────────┘
                                  │ - ingest     │
                                  │ - dashboard  │         ┌──────────────┐
                                  │ - auth       │────────▶│   Redis      │
                                  │ - actions    │         │  (named vol) │
                                  └──────────────┘         └──────┬───────┘
                                                                  │ BullMQ
                                  ┌──────────────┐                │
                                  │ worker       │◀───────────────┘
                                  │ (tsx)        │
                                  │ - filter     │────────▶ destination URLs (fetch)
                                  │ - transform  │            (HTTPS with 10s timeout)
                                  │ - retry      │
                                  └──────────────┘
```

Five containers, one Docker bridge network (`hooksmith_default`), four named volumes (`hooksmith_odyhook_pg`, `hooksmith_odyhook_redis`, `hooksmith_caddy_data`, `hooksmith_caddy_config`).

---

## External services

| Service | Role | Account / identifier | Where to manage |
|---|---|---|---|
| **Porkbun** | Domain registrar + DNS for `odyhook.dev` | Account: `ngkdev93@gmail.com` | [porkbun.com](https://porkbun.com) |
| **Resend** | SMTP for magic-link emails. Domain `odyhook.dev` verified (DKIM/SPF/DMARC). Sends from `no-reply@odyhook.dev`. | API key in server's `EMAIL_SERVER_PASSWORD`. | [resend.com/domains](https://resend.com/domains) |
| **Cloudflare R2** | Off-site DB backup storage | Account ID `728e0c68f696f31ad2029513f3e9962b`. Bucket `odyhook-backups`, region EEUR, 14-day object lifecycle. | [dash.cloudflare.com](https://dash.cloudflare.com) → R2 |
| **Sentry** | Error tracking for web + worker | Org `odyhook`, region DE, project key in `SENTRY_DSN` | [sentry.io](https://sentry.io) |
| **GitHub** | Source repo + Actions runner | `github.com/NikosGkikas13/odyhook` (public) | [github.com](https://github.com) |
| **GitHub OAuth App** | "Continue with GitHub" sign-in path | Callback: `https://odyhook.dev/api/auth/callback/github`. Client ID + secret in server's `.env`. | [github.com/settings/developers](https://github.com/settings/developers) |
| **Hetzner Cloud** | VPS host | Server `hooksmith` in Helsinki | [console.hetzner.cloud](https://console.hetzner.cloud) |
| **Anthropic API** | User-provided AI keys (BYOK model) | No central key — each user supplies their own in Settings → API Keys. Encrypted at rest with `ENCRYPTION_KEY`. | n/a — per-user |

---

## DNS records (at Porkbun, for `odyhook.dev`)

| Type | Host | Value | Purpose |
|---|---|---|---|
| A | (apex / blank) | `157.180.91.106` | `odyhook.dev` → server |
| A | `www` | `157.180.91.106` | `www` → server (Caddy redirects to apex) |
| MX | `send` | `feedback-smtp.eu-west-1.amazonses.com` priority `10` | Resend bounce/reply handling |
| TXT | `send` | `v=spf1 include:amazonses.com ~all` | SPF |
| TXT | `resend._domainkey` | (long DKIM `p=...` blob; see Resend dashboard) | DKIM signing |
| TXT | `_dmarc` | `v=DMARC1; p=none;` | DMARC reporting |

If any of these are removed at Porkbun, Resend's verification status flips back to "Pending" and email sending fails until restored.

---

## Deployment

### Auto-deploy (the normal path)

Push to `main` triggers `.github/workflows/deploy.yml`:

1. GitHub Actions runner stores `DEPLOY_SSH_KEY` (secret) to `~/.ssh/id_ed25519`
2. Pins server's known_hosts ed25519 fingerprint inline (anti-MITM)
3. SSHes to `root@157.180.91.106` with that key
4. The key's `command=` restriction in `authorized_keys` forces execution of `/usr/local/bin/odyhook-deploy.sh`
5. That script runs `git pull --ff-only origin main && docker compose -f docker-compose.prod.yml up -d --build`

**Typical timings:**
- UI-only change: ~90s (most layers cached, only `npm run build` re-runs)
- Dependency change: ~3 min (`npm ci` reruns)
- Dockerfile early-stage change: ~5 min (full rebuild)

**Concurrency:** workflow uses `concurrency: deploy-production cancel-in-progress: false` — never runs two deploys simultaneously.

### Deploy-key restrictions (in `/root/.ssh/authorized_keys`)

```
command="/usr/local/bin/odyhook-deploy.sh",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty ssh-ed25519 AAAA... github-actions-deploy@odyhook
```

Even if `DEPLOY_SSH_KEY` leaks (e.g., from Actions logs), an attacker can only force a redeploy of `main` — no shell, no port tunnel, no other commands.

### Manual deploy (when CI is down)

```sh
ssh root@157.180.91.106
cd /opt/hooksmith
git pull --ff-only origin main
docker compose -f docker-compose.prod.yml up -d --build
```

### What is NOT in the deploy pipeline (deliberately, for now)

- **No tests** before deploy. A broken push fails at `npm run build` on the server but isn't caught earlier.
- **No staging environment.** `main` is production.
- **No automatic rollback.** A failed deploy leaves old containers running (good default) but you must `git revert` to recover.
- **No release tagging.** Each deploy is identified only by the git commit hash.

---

## Scheduled jobs

System cron at `/etc/cron.d/odyhook`. Output → `/var/log/odyhook-cron.log`.

| When (UTC) | Job | Command | What it does |
|---|---|---|---|
| Daily 03:00 | DB backup | `/usr/local/bin/odyhook-backup.sh` | `pg_dump` → gzip → R2 |
| Daily 04:00 | Retention purge | `npm run job:purge` (in web container) | Deletes events older than each source's `retentionDays` window (deliveries cascade). Sources with null retention are kept indefinitely. |
| Daily 09:00 | Drift check | `npm run job:drift` (in web container) | Detects destinations whose response shape changed; emails the owner |
| Weekly Mon 09:00 | Activity digest | `npm run job:digest` (in web container) | Emails each user a summary of webhook activity |

`cron` re-reads `/etc/cron.d/` every minute — no daemon restart needed after editing.

**To wire the purge job**, add this line to `/etc/cron.d/odyhook` (UTC):

```cron
0 4 * * * root cd /opt/hooksmith && docker compose -f docker-compose.prod.yml exec -T web npm run job:purge >> /var/log/odyhook-cron.log 2>&1
```

---

## Backups (Cloudflare R2)

| Aspect | Details |
|---|---|
| What | Postgres only (`pg_dump`). Not Redis (transient queue). Not Caddy certs (auto-regen). |
| Where | R2 bucket `odyhook-backups` |
| Frequency | Nightly 03:00 UTC |
| Format | `odyhook-YYYY-MM-DDTHH-MM-SSZ.sql.gz` |
| Retention | 14 days (R2 lifecycle auto-delete) |
| Script | `/usr/local/bin/odyhook-backup.sh` — streams `pg_dump | gzip | rclone rcat` (no temp file) |
| rclone config | `/root/.config/rclone/rclone.conf`, mode 600, profile `[r2]` with `no_check_bucket = true` (scoped tokens can't ListBuckets) |
| Backup size | ~3 KB compressed initially, expected ~50 MB–700 MB at scale |

Restore procedure: see [recovery.md](recovery.md#postgres-restore-from-r2).

---

## Environment variables

All in `/opt/hooksmith/.env` on the server (mode 600, gitignored). Loaded by Docker Compose via `env_file: .env`. **`NEXT_PUBLIC_APP_URL` is also passed as a Compose `build` arg** because it's inlined into the client JS bundle at build time.

| Variable | Purpose | Build- or run-time | Rotation impact |
|---|---|---|---|
| `NODE_ENV` | Standard prod flag | runtime | none |
| `POSTGRES_USER` `_PASSWORD` `_DB` | Postgres container init creds | runtime | Rotating requires DB user rename or DB rebuild; update `DATABASE_URL` too |
| `DATABASE_URL` | App → Postgres connection string | runtime | Must match POSTGRES_* values |
| `REDIS_URL` | App → Redis (`redis://redis:6379`) | runtime | none |
| `AUTH_SECRET` | NextAuth JWT signing | runtime | Rotating logs out everyone, not catastrophic |
| `AUTH_URL` | OAuth/magic-link callback base (`https://odyhook.dev`) | runtime | Must match the public URL |
| `ENCRYPTION_KEY` | AES-256-GCM key for at-rest column encryption (signing secrets, destination headers, user Anthropic keys) | runtime | ⚠️ **Catastrophic.** Rotating invalidates every encrypted DB column. Requires a rewrap migration. |
| `EMAIL_SERVER_HOST` `_PORT` `_USER` `_PASSWORD` | Resend SMTP | runtime | Get new API key from Resend dashboard |
| `EMAIL_FROM` | Sender (`Odyhook <no-reply@odyhook.dev>`) | runtime | Domain must stay verified in Resend |
| `NEXT_PUBLIC_APP_URL` | Public base URL inlined in client JS | **build-time** | Wrong value → ingest URLs in dashboard point at the wrong host; requires `up -d --build` |
| `AUTH_GITHUB_ID` `AUTH_GITHUB_SECRET` | GitHub OAuth app | runtime | Regenerate secret at github.com/settings/developers |
| `SENTRY_DSN` | Error reporting endpoint | runtime | DSN is public-ish; rotate if abuse |
| `RATE_LIMIT_PER_SEC` `RATE_LIMIT_BURST` | Default rate-limit when no per-source override (default 10/20) | runtime | numeric tuning |
| `DESTINATION_FAILURE_THRESHOLD` | Consecutive exhausted deliveries before auto-disabling a destination (default `5`). | runtime | numeric tuning |
| `API_RATE_LIMIT_PER_SEC` | Per-API-token REST API rate limit refill (default 10/sec) | runtime | numeric tuning |
| `API_RATE_LIMIT_BURST` | Per-API-token REST API rate limit burst capacity (default 30) | runtime | numeric tuning |

**There is no off-site backup of `.env` currently.** If the server is destroyed, you'd regenerate most values from external dashboards but `ENCRYPTION_KEY` loss is unrecoverable for encrypted columns. See [recovery.md](recovery.md#lost-env-file).

---

## Observability

| Surface | Where to look |
|---|---|
| **Application exceptions** (web + worker) | [Sentry dashboard](https://sentry.io) → project `odyhook` → Issues |
| **Container logs (live)** | SSH in → `docker compose -f docker-compose.prod.yml logs -f <service>` |
| **Cron job output** | SSH in → `tail -f /var/log/odyhook-cron.log` |
| **Deploy history** | [github.com/NikosGkikas13/odyhook/actions](https://github.com/NikosGkikas13/odyhook/actions) |
| **Caddy / TLS status** | `docker compose logs caddy` (cert renewals appear here) |
| **R2 backup inventory** | `rclone ls r2:odyhook-backups | sort -r | head` |

**Known gap:** there's no alerting on cron exit codes. Sentry catches exceptions in running code but doesn't fire if the nightly backup script silently fails three nights in a row. Mitigation idea (not implemented): hit a [healthchecks.io](https://healthchecks.io) URL from the backup script on success — they ping you when no pings arrive on schedule.

---

## Local development

```sh
# Spin up Postgres, Redis, MailHog
docker compose up -d

# Apply migrations
npm run db:migrate

# Run Next.js + worker in two terminals
npm run dev          # web at localhost:3000
npm run worker       # worker (watches src/workers/delivery.ts)
```

Magic-link emails go to **MailHog at `http://localhost:8025`** — there's no SMTP in dev unless you set `EMAIL_SERVER_*` env vars. The signin page renders a hint linking to MailHog when `NODE_ENV !== "production"`.

See the project's top-level [README.md](../README.md) for the full developer quickstart.

---

## Common operations

```sh
# Status of all containers
docker compose -f docker-compose.prod.yml ps

# Tail a specific service
docker compose -f docker-compose.prod.yml logs -f web

# Restart web+worker after a .env change (no rebuild needed for runtime env)
docker compose -f docker-compose.prod.yml up -d --force-recreate web worker

# Full rebuild (needed after Dockerfile or NEXT_PUBLIC_* changes)
docker compose -f docker-compose.prod.yml up -d --build

# Inspect actual env in the running container
docker compose -f docker-compose.prod.yml exec web printenv | grep -E '^(AUTH_URL|EMAIL_FROM|SENTRY_DSN)'

# Trigger a backup manually
/usr/local/bin/odyhook-backup.sh

# List backups in R2
rclone ls r2:odyhook-backups | sort -r | head

# Run cron jobs on demand
docker compose -f docker-compose.prod.yml exec -T web npm run job:drift
docker compose -f docker-compose.prod.yml exec -T web npm run job:digest
docker compose -f docker-compose.prod.yml exec -T web npm run job:purge

# Open a psql shell into the running DB
docker compose -f docker-compose.prod.yml exec postgres psql -U hooksmith hooksmith

# Trigger a one-off Sentry test event
docker compose -f docker-compose.prod.yml exec -T worker node -e "
const Sentry = require('@sentry/nextjs');
Sentry.init({ dsn: process.env.SENTRY_DSN, enabled: true });
Sentry.captureException(new Error('manual test'));
Sentry.flush(5000).then(() => process.exit(0));
"
```

---

## Cost breakdown (monthly, EUR)

| Item | Cost |
|---|---|
| Hetzner CX23 server | €4.95 |
| Porkbun `odyhook.dev` domain | ~€1.07/mo (paid annually) |
| Resend (free tier — 3,000 emails/mo) | €0 |
| Cloudflare R2 (well under 10 GB / 1M writes / 10M reads free tier) | €0 |
| Sentry (free tier — 5k events/mo) | €0 |
| GitHub Actions (public repo — unlimited minutes) | €0 |
| Anthropic API (BYOK — each user pays for their own usage) | €0 to Odyhook |
| **Total ongoing** | **~€6/month** |

---

## Project decisions log

These are non-obvious choices worth knowing about before "fixing" them:

- **Postgres DB name is still `hooksmith`** even after the Odyhook rebrand. Avoiding a `pg_dump`+restore migration. Internal name only — never user-visible. See [project_odyhook_rename](../../.claude/projects/-Users-nikosgkikas-Desktop-PracticeProjects-hooksmith/memory/project_odyhook_rename.md) (Claude memory).
- **`/opt/hooksmith` directory** on the server (not `/opt/odyhook`). Renaming would require `docker compose down` and reconnecting named volumes; cosmetic only. Same reason as DB name.
- **Compose project name `hooksmith`** (basename of the directory). Container names show as `hooksmith-web-1`, `hooksmith-postgres-1`, etc. Cosmetic.
- **Repo on user's laptop also at `~/Desktop/PracticeProjects/hooksmith`** — not renamed for the same reason.
- **GitHub repo was renamed `hooksmith` → `odyhook`** (2026-05-24). Canonical URL is now `github.com/NikosGkikas13/odyhook`. GitHub auto-redirects the old `.../hooksmith` URL for clone/push/PR/secrets, so the deploy workflow and any local remote still pointing at the old name keep working — update them opportunistically. The local repo dir, `/opt/hooksmith`, the Compose project name, and the Postgres DB name still say "hooksmith" (cosmetic; renaming those would need a `pg_dump` migration).
- **Sign-in page lives at `/signin`**, has both GitHub and email options. Homepage links to `/signin` with a single button — duplicate "Continue with GitHub" was removed.
- **`onboarding@resend.dev`** was used as the From address until `odyhook.dev` was verified in Resend. Now using `no-reply@odyhook.dev`. The `no-reply@` mailbox doesn't actually exist — Resend only handles outbound; nobody can reply to those emails.
- **Anthropic is BYOK.** There's no central Anthropic key in `.env`. Each user pastes their own at Settings → API Keys, encrypted with `ENCRYPTION_KEY`.

---

## Known gaps / not set up (deliberately)

Call these out before assuming they exist:

- **No staging environment.** Pushes go straight to prod.
- **No CI tests before deploy.** Failures caught only at server-side build.
- **No off-site backup of `.env`.** See [recovery.md](recovery.md#lost-env-file) for the consequences.
- **No alerting on cron failures.** Backup script could silently fail; nothing pages you.
- **Security headers** are set in `next.config.ts` (HSTS, X-Frame-Options: DENY, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, and a `frame-ancestors`/`base-uri`/`object-src` CSP). A strict `script-src` CSP (needs per-request nonces via middleware) is still **not** set.
- **No rate-limit alerting.** Per-source 429s land in the dashboard but don't notify the source owner.
- **No automated DB restore drill.** Untested backups are wishful thinking — see recovery.md for a manual procedure.

When implementing any of these, update this section.

---

## Where to look for more

| Topic | File |
|---|---|
| Why each tech was chosen | [ARCHITECTURE.md](../ARCHITECTURE.md) |
| Disaster recovery procedures | [infra/recovery.md](recovery.md) |
| Original "we just rented this server" walkthrough | [hetzner.md](../hetzner.md) |
| Earlier deployment doc (some content stale — Fly.io path was never used) | [DEPLOY.md](../DEPLOY.md) |
| Local-dev quickstart | [README.md](../README.md) |
| Next.js 16 specifics (it's NOT the Next.js you know) | [AGENTS.md](../AGENTS.md) |
