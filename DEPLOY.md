# Deploying Odyhook to Production

This document captures everything needed to take Odyhook from "runs on my laptop" to a running production deployment. It is documentation only — none of the code changes listed in [§3](#3-pre-deploy-fix-ups) have been applied yet, and an operator should work through that section before the first deploy.

## Table of contents

1. [Architecture summary](#1-architecture-summary)
2. [Environment variables](#2-environment-variables)
3. [Pre-deploy fix-ups](#3-pre-deploy-fix-ups)
4. [Deploy path A — Fly.io (recommended)](#4-deploy-path-a--flyio-recommended)
5. [Deploy path B — Single VPS via docker-compose](#5-deploy-path-b--single-vps-via-docker-compose)
6. [Post-deploy verification](#6-post-deploy-verification)

---

## 1. Architecture summary

Odyhook is a webhook router with an AI-assisted transformation builder. A production deployment must provision **two long-lived Node processes plus three external services**:

| Component | Process / image | Notes |
| --- | --- | --- |
| Web server | `npm start` (Next.js 16, Node 22+) | Serves the dashboard, NextAuth routes, and the public `/api/ingest/[slug]` endpoint. Listens on `$PORT` (default 3000). |
| Delivery worker | `npm run worker:prod` (Node 22+) | Runs [src/workers/delivery.ts](src/workers/delivery.ts). Pulls from the BullMQ queue and delivers events to destinations. **No exposed port.** |
| PostgreSQL 16+ | Managed (Fly Postgres / Neon / Supabase / RDS) | Prisma 7 with `@prisma/adapter-pg`. Schema in [prisma/schema.prisma](prisma/schema.prisma). |
| Redis 7+ | Managed (Upstash / Fly Redis / ElastiCache) | BullMQ queue + token-bucket rate limiter ([src/lib/ratelimit.ts](src/lib/ratelimit.ts)). TLS (`rediss://`) recommended. |
| SMTP relay | Managed (SES / Postmark / Resend SMTP / Mailgun) | Magic-link sign-in via Nodemailer ([src/auth.ts](src/auth.ts)). |

Optional but recommended:

- **External scheduler** (Fly scheduled machines, GitHub Actions cron, systemd timers) for `npm run job:drift` and `npm run job:digest` — these are not auto-triggered.
- **Error tracking** (Sentry, Highlight, etc.) — currently logging is unstructured `console.log`.

Anthropic API access uses a **bring-your-own-key** model: each user pastes their own API key in Settings, and it is encrypted at rest with `ENCRYPTION_KEY`. There is no central Anthropic key for the deployment to provide.

---

## 2. Environment variables

Source of truth: [.env.example](.env.example) and audit of `process.env.*` references in `src/`.

| Variable | Required | Purpose | How to provision |
| --- | --- | --- | --- |
| `DATABASE_URL` | Yes | PostgreSQL connection string. Append `?sslmode=require` for managed providers. | Connection string from your Postgres provider. |
| `REDIS_URL` | Yes | BullMQ queue + rate limiter ([src/lib/queue.ts](src/lib/queue.ts), [src/lib/ratelimit.ts](src/lib/ratelimit.ts)). | Connection string from Upstash / Fly Redis / etc. Prefer `rediss://` for TLS. |
| `AUTH_SECRET` | Yes | NextAuth v5 JWT signing key. | `openssl rand -base64 32` |
| `AUTH_URL` | Yes | Public HTTPS base URL used for OAuth/magic-link callbacks. | `https://app.example.com` |
| `ENCRYPTION_KEY` | Yes | AES-256-GCM key used to encrypt destination headers, source signing secrets, and user-provided Anthropic API keys at rest ([src/lib/crypto.ts](src/lib/crypto.ts)). | `openssl rand -base64 32`. **Rotating this key invalidates every encrypted secret in the database** — plan a rewrap migration if you ever rotate. |
| `EMAIL_SERVER_HOST` | Yes | SMTP host for magic-link delivery. | Provider host (e.g. `smtp.resend.com`). |
| `EMAIL_SERVER_PORT` | Yes | SMTP port (typically 587 or 465). | Provider port. |
| `EMAIL_SERVER_USER` | Yes | SMTP username / API key id. | Provider credential. |
| `EMAIL_SERVER_PASSWORD` | Yes | SMTP password / API secret. | Provider credential. |
| `EMAIL_FROM` | Yes | `From:` address for magic links. Domain must be verified at the provider. | `Odyhook <no-reply@yourdomain.com>` |
| `NEXT_PUBLIC_APP_URL` | Yes | Public base URL shown in the dashboard's copy-to-clipboard ingest URLs. **Must be set at build time** (it is inlined into the client bundle). | Same value as `AUTH_URL`. |
| `RATE_LIMIT_PER_SEC` | No | Default sustained per-source rate (token-bucket refill rate). Default `10`. | Numeric. |
| `RATE_LIMIT_BURST` | No | Default per-source burst capacity. Default `20`. | Numeric. |
| `NODE_ENV` | Yes | Standard Next.js production flag. | `production` (Fly / most platforms set this automatically). |
| `PORT` | Sometimes | Web server listen port. | Most platforms set this automatically; `npm start` honors it. |

`NEXT_PUBLIC_*` is a Next.js convention for variables embedded in the client bundle — set it before `npm run build`, not just at runtime, or the dashboard will show stale URLs.

---

## 3. Pre-deploy fix-ups

These gaps were found during the audit and **should be addressed before the first production deploy**. None require deep redesign; they're listed in priority order.

### 3.1 Rotate the secrets in `.env`

`AUTH_SECRET` and `ENCRYPTION_KEY` were filled in with real values during local development. `.env*` is gitignored, so they are not in git history, but they must be regenerated for production and stored only in the platform's secret manager (Fly secrets, AWS SSM, GitHub Actions secrets, etc.) — never committed.

```sh
openssl rand -base64 32   # for AUTH_SECRET
openssl rand -base64 32   # for ENCRYPTION_KEY (different value)
```

### 3.2 Add a production migration script — ✅ done

[package.json:18](package.json#L18) now exposes `db:deploy` (`prisma migrate deploy`). Call `npm run db:deploy` in the release step (or rely on Fly's `release_command` in §4.3, which calls `prisma migrate deploy` directly).

### 3.3 Hide the MailHog link on the sign-in page — ✅ done

[src/app/signin/page.tsx](src/app/signin/page.tsx) now gates the dev hint on `process.env.NODE_ENV !== "production"`.

### 3.4 Wire up email sending for the scheduled jobs — ✅ done

Shared transport at [src/lib/mailer.ts](src/lib/mailer.ts) reuses the `EMAIL_SERVER_*` / `EMAIL_FROM` env vars already used by [src/auth.ts](src/auth.ts).

- [src/scripts/digest.ts](src/scripts/digest.ts) — emails each user with activity. Set `DIGEST_DRY_RUN=1` to print bodies to stdout instead of sending.
- [src/scripts/drift.ts](src/scripts/drift.ts) — only emails on actual drift, batched per owner so each user gets at most one message per run. Set `DRIFT_DRY_RUN=1` to print instead of sending.

The cron schedule (§3.6) is now meaningful and worth wiring up.

### 3.5 Add structured logging / error tracking — fast-follow

Still using `console.*`. This is a low-risk upgrade — pick a vendor (Sentry, Highlight, Logtail) and instrument the web entry plus [src/workers/delivery.ts](src/workers/delivery.ts) in the first patch release. Not a launch blocker.

### 3.6 Schedule the cron jobs

`npm run job:drift` and `npm run job:digest` are intended to run periodically but are not auto-triggered. Schedule them via:

- **Fly.io**: `flyctl machines run --schedule daily ...` per script.
- **GitHub Actions**: `.github/workflows/cron.yml` with `on.schedule.cron` calling the deployed app's exec endpoint, or running the scripts directly against the prod database.
- **VPS**: a systemd timer or plain `cron` entry running `npm run job:drift` on the deployed image.

---

## 4. Deploy path A — Fly.io (recommended)

Fly is the recommended target because Odyhook needs a long-lived BullMQ worker, which rules out pure-Vercel/Netlify deployments. Fly's `[processes]` config lets the web server and worker share one image and one deploy.

### 4.1 One-time setup

```sh
flyctl auth login
flyctl launch --no-deploy        # creates fly.toml; pick a region and app name
```

Provision data services:

```sh
flyctl postgres create --name odyhook-db
flyctl postgres attach odyhook-db    # sets DATABASE_URL on the app

flyctl redis create                    # Upstash-backed Redis; sets REDIS_URL
```

Set the remaining secrets (replace values):

```sh
flyctl secrets set \
  AUTH_SECRET="$(openssl rand -base64 32)" \
  AUTH_URL="https://odyhook.fly.dev" \
  NEXT_PUBLIC_APP_URL="https://odyhook.fly.dev" \
  ENCRYPTION_KEY="$(openssl rand -base64 32)" \
  EMAIL_SERVER_HOST="smtp.resend.com" \
  EMAIL_SERVER_PORT="587" \
  EMAIL_SERVER_USER="resend" \
  EMAIL_SERVER_PASSWORD="re_xxx" \
  EMAIL_FROM="Odyhook <no-reply@yourdomain.com>"
```

### 4.2 `Dockerfile`

Add this at the repo root. It is a standard multi-stage Node 22 build; `postinstall` already runs `prisma generate`.

```dockerfile
# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS base
WORKDIR /app
ENV NODE_ENV=production

FROM base AS deps
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# NEXT_PUBLIC_APP_URL must be present at build time
ARG NEXT_PUBLIC_APP_URL
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL
RUN npm run build

FROM base AS runtime
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/src ./src
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/next.config.ts ./next.config.ts
EXPOSE 3000
CMD ["npm", "start"]
```

### 4.3 `fly.toml` additions

```toml
[build]
  dockerfile = "Dockerfile"
  [build.args]
    NEXT_PUBLIC_APP_URL = "https://odyhook.fly.dev"

[deploy]
  release_command = "npx prisma migrate deploy"

[processes]
  web    = "npm start"
  worker = "npm run worker:prod"

[[services]]
  processes = ["web"]
  internal_port = 3000
  protocol = "tcp"
  [[services.ports]]
    port = 80
    handlers = ["http"]
    force_https = true
  [[services.ports]]
    port = 443
    handlers = ["tls", "http"]
```

The `release_command` runs `prisma migrate deploy` once per deploy before any machine takes traffic — that replaces the `db:deploy` script call for Fly.

### 4.4 Deploy

```sh
flyctl deploy
flyctl logs        # tail web + worker
flyctl status      # confirm both processes are healthy
```

### 4.5 Schedule cron (after §3.4)

```sh
flyctl machines run . --schedule daily --command "npm run job:drift"
flyctl machines run . --schedule weekly --command "npm run job:digest"
```

---

## 5. Deploy path B — Single VPS via docker-compose

The repo already has [docker-compose.yml](docker-compose.yml) with Postgres, Redis, and MailHog for local dev. For production on a single VPS (Hetzner, DigitalOcean, EC2):

1. **Build app images** — add `web` and `worker` services to a separate `docker-compose.prod.yml`, both built from the [§4.2 Dockerfile](#42-dockerfile). Worker overrides `command: npm run worker:prod`.
2. **Drop MailHog**, point `EMAIL_SERVER_*` at a real SMTP relay.
3. **Externalize secrets** — `env_file: ./.env.production` (gitignored, copied via SCP / managed via something like `sops`).
4. **Front with Caddy** for automatic TLS — needed for the magic-link callback URLs to work. Caddy proxies `:443` → `web:3000`.
5. **Run migrations on each deploy**:

   ```sh
   docker compose -f docker-compose.yml -f docker-compose.prod.yml \
     run --rm web npx prisma migrate deploy
   ```

6. **Schedule cron** via the host's `cron` running `docker compose ... exec web npm run job:digest`.

7. **Pin Postgres + Redis to volumes** (already done in the dev compose file via `odyhook_pg` and `odyhook_redis` — keep those, do not remove on `down`).

Operationally heavier than Fly (you own backups, OS patches, TLS rotation), but cheaper and self-contained.

---

## 6. Post-deploy verification

Run through this checklist after the first deploy completes.

- [ ] `curl -I https://odyhook.example.com/` returns `200`.
- [ ] `flyctl status` (or `docker compose ps`) shows `web` and `worker` both healthy / running.
- [ ] `npx prisma migrate status` against the prod DB reports "Database schema is up to date."
- [ ] Sign-in flow end-to-end:
  - [ ] Submit email on `/signin`.
  - [ ] Magic-link email arrives at the test inbox via the production SMTP relay.
  - [ ] Click-through lands on the dashboard authenticated.
- [ ] Webhook ingest end-to-end:
  - [ ] Create a Source in the dashboard; copy the ingest URL and signing secret.
  - [ ] `curl -X POST` the ingest URL with a valid HMAC `X-Odyhook-Signature` header (see [src/lib/hmac.ts](src/lib/hmac.ts) for the scheme).
  - [ ] Confirm an `Event` row appears in Postgres.
  - [ ] Confirm a `Delivery` row transitions to `delivered` (or `failed` with a real error).
  - [ ] `flyctl logs -i <worker-machine>` shows the worker picking up and dispatching the job.
- [ ] Rate limiter is live: `redis-cli KEYS 'rl:*'` (or Upstash console) shows entries after a few ingests.
- [ ] (If §3.4 was completed) Manually trigger `npm run job:digest` and `npm run job:drift` once — confirm an email actually arrives, not just stdout.
- [ ] No errors in the first 30 minutes of `flyctl logs` / `docker compose logs`.

If any check fails, investigate before announcing the deployment — a silently broken worker or rate limiter is worse than an obviously broken landing page.
