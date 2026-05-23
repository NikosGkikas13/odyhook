# Odyhook Infrastructure

The "what's deployed where" reference. Keep this current — out-of-date infra docs are worse than none.

---

## Production snapshot

| Item | Value |
|---|---|
| Public URL | `https://odyhook.dev` (apex), `www` → apex 301 |
| Server | Hetzner Cloud CX23, Helsinki, `157.180.91.106` |
| Server cost | €4.95/month |
| Repo on server | `/opt/hooksmith` (single canonical checkout) |
| Compose project name | `hooksmith` (derived from directory basename — kept for volume continuity even after the brand rename) |
| Container image | `odyhook-app:latest` (built locally on the server from the repo's Dockerfile) |

## Stack architecture

Five containers managed by `docker-compose.prod.yml`:

```
Internet ──TLS──▶ caddy ──▶ web (Next.js) ──▶ postgres
                              │                  │
                              ▼                  │
                            redis ◀── worker ────┘
                              (BullMQ queue)
```

| Service | Image | Role | Persistent |
|---|---|---|---|
| `caddy` | `caddy:2-alpine` | TLS termination, reverse proxy. Obtains certs from Let's Encrypt. | `caddy_data`, `caddy_config` volumes |
| `web` | `odyhook-app:latest` | Next.js app — dashboard + API + ingest endpoint | no |
| `worker` | `odyhook-app:latest` | BullMQ delivery worker — same image, `npm run worker:prod` | no |
| `postgres` | `postgres:16-alpine` | Application DB | `hooksmith_odyhook_pg` volume on disk (named `odyhook_pg` in compose) |
| `redis` | `redis:7-alpine` | BullMQ queue + rate-limit token buckets | `hooksmith_odyhook_redis` volume |

**Postgres DB name:** still `hooksmith` (kept on rebrand to avoid a `pg_dump`+restore migration). Database/role naming is internal — no user-visible impact.

## External services

| Service | Role | Account/identifier |
|---|---|---|
| **Porkbun** | Domain registrar + DNS for `odyhook.dev` | Account: ngkdev93@gmail.com |
| **Resend** | SMTP for magic-link emails | Domain `odyhook.dev` verified (DKIM/SPF). Sends from `no-reply@odyhook.dev`. |
| **Cloudflare R2** | Off-site DB backup storage | Bucket `odyhook-backups`, region EEUR, 14-day lifecycle, account ID `728e0c68f696f31ad2029513f3e9962b` |
| **Sentry** | Error tracking (web + worker) | Org `odyhook`, region DE (EU), project key in `SENTRY_DSN` |
| **GitHub** | Source repo + Actions runner | `github.com/NikosGkikas13/hooksmith` (public) |
| **GitHub OAuth App** | "Continue with GitHub" sign-in | Callback URL: `https://odyhook.dev/api/auth/callback/github` |

## DNS records (at Porkbun)

| Type | Host | Value | For |
|---|---|---|---|
| A | (apex) | `157.180.91.106` | `odyhook.dev` |
| A | `www` | `157.180.91.106` | `www` → apex |
| MX | `send` | `feedback-smtp.eu-west-1.amazonses.com` (priority 10) | Resend bounce handling |
| TXT | `send` | `v=spf1 include:amazonses.com ~all` | SPF |
| TXT | `resend._domainkey` | (long DKIM `p=...` blob) | DKIM signing |
| TXT | `_dmarc` | `v=DMARC1; p=none;` | DMARC reporting |

## Deployment

### Automatic (the normal path)

Push to `main` → GitHub Actions workflow `.github/workflows/deploy.yml`:

1. SSHes into `157.180.91.106` with a key restricted to running ONE command
2. The forced command on the server is `/usr/local/bin/odyhook-deploy.sh`
3. That script does `git pull --ff-only` + `docker compose up -d --build`
4. Total time: ~90s for a typical code change, ~5 min for a Dockerfile change

The deploy key is configured in `/root/.ssh/authorized_keys` with:

```
command="/usr/local/bin/odyhook-deploy.sh",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty ssh-ed25519 AAAA... github-actions-deploy@odyhook
```

Private key stored as GitHub Actions secret `DEPLOY_SSH_KEY`. Server's host key is pinned in the workflow YAML for MITM protection.

### Manual (when CI is down or for emergency)

```sh
ssh root@157.180.91.106
cd /opt/hooksmith
git pull --ff-only origin main
docker compose -f docker-compose.prod.yml up -d --build
```

## Scheduled jobs

System cron at `/etc/cron.d/odyhook`. Output goes to `/var/log/odyhook-cron.log`.

| Schedule | Job | Command |
|---|---|---|
| Daily 03:00 UTC | DB backup → R2 | `/usr/local/bin/odyhook-backup.sh` |
| Daily 09:00 UTC | Destination drift check | `npm run job:drift` (inside web container) |
| Weekly Monday 09:00 UTC | Activity digest emails | `npm run job:digest` (inside web container) |

The cron daemon re-reads `/etc/cron.d/` every minute — no restart needed after editing.

## Backups

| Aspect | Details |
|---|---|
| What's backed up | Postgres only (via `pg_dump`). Not Redis (transient queue state). Not Caddy certs (auto-regen). |
| Where | Cloudflare R2 bucket `odyhook-backups` |
| Frequency | Nightly at 03:00 UTC via cron |
| Format | `odyhook-YYYY-MM-DDTHH-MM-SSZ.sql.gz` (gzipped) |
| Retention | 14 days (R2 lifecycle rule auto-deletes older) |
| Script | `/usr/local/bin/odyhook-backup.sh` — streams `pg_dump | gzip | rclone rcat`, no intermediate file |
| Tool | `rclone` configured at `/root/.config/rclone/rclone.conf` (mode 600), profile `[r2]` |

### Restore procedure

```sh
# 1. List available backups
ssh root@157.180.91.106 'rclone ls r2:odyhook-backups | sort -r | head -10'

# 2. Pull a specific one and pipe directly into postgres
ssh root@157.180.91.106 'rclone cat r2:odyhook-backups/odyhook-<timestamp>.sql.gz \
  | gunzip \
  | docker compose -f /opt/hooksmith/docker-compose.prod.yml exec -T postgres psql -U hooksmith hooksmith'
```

**Caveat:** restoring INTO a running DB requires either an empty DB (drop+recreate first) or careful conflict handling. For a real restore drill, stop the web/worker first to prevent writes.

## Environment variables

All in `/opt/hooksmith/.env` on the server (mode 600, gitignored). Loaded by `docker-compose.prod.yml` via `env_file: .env` and `NEXT_PUBLIC_APP_URL` is also passed as a `build:` arg (it's inlined into the client bundle at build time).

| Variable | Purpose | Rotation impact |
|---|---|---|
| `NODE_ENV` | Standard Next.js prod flag | None — always `production` |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | Postgres container creds (`hooksmith` user/db) | Changing requires DB user rename + DATABASE_URL update |
| `DATABASE_URL` | App → Postgres (`postgres://hooksmith:...@postgres:5432/hooksmith`) | Must match POSTGRES_* values |
| `REDIS_URL` | App → Redis (`redis://redis:6379`) | None |
| `AUTH_SECRET` | NextAuth JWT signing | Rotating logs out everyone |
| `AUTH_URL` | OAuth/magic-link callback base (`https://odyhook.dev`) | Must match deployed URL |
| `ENCRYPTION_KEY` | AES-256-GCM for encrypted columns (destination headers, signing secrets, Anthropic API keys) | **Rotating invalidates ALL encrypted DB columns** — plan a rewrap migration |
| `EMAIL_SERVER_HOST` / `_PORT` / `_USER` / `_PASSWORD` | SMTP creds (Resend) | Get fresh API key from Resend dashboard |
| `EMAIL_FROM` | Magic-link sender (`Odyhook <no-reply@odyhook.dev>`) | Domain must stay verified in Resend |
| `NEXT_PUBLIC_APP_URL` | Public base URL inlined in client JS (`https://odyhook.dev`) | **Build-time** — requires `up -d --build`, not just restart |
| `AUTH_GITHUB_ID` / `AUTH_GITHUB_SECRET` | GitHub OAuth | Regenerate secret in GitHub dev settings if leaked |
| `SENTRY_DSN` | Error reporting endpoint | Public-ish; can rotate if abuse occurs |

## Observability

| Source | Where to look |
|---|---|
| Application errors (web + worker) | Sentry dashboard, project `odyhook` |
| Container logs (live) | `docker compose -f docker-compose.prod.yml logs -f <service>` on the server |
| Cron job output | `/var/log/odyhook-cron.log` on the server |
| Deploy history | `https://github.com/NikosGkikas13/hooksmith/actions` |
| Caddy / TLS status | `docker compose -f docker-compose.prod.yml logs caddy` (cert renewals appear here) |

## Common operations

```sh
# SSH in
ssh root@157.180.91.106

# Status of everything
cd /opt/hooksmith && docker compose -f docker-compose.prod.yml ps

# Tail one service
docker compose -f docker-compose.prod.yml logs -f web

# Restart web+worker after .env change (no rebuild)
docker compose -f docker-compose.prod.yml up -d --force-recreate web worker

# Full rebuild (after Dockerfile or NEXT_PUBLIC_* changes)
docker compose -f docker-compose.prod.yml up -d --build

# Run a one-off manual backup
/usr/local/bin/odyhook-backup.sh

# List backups in R2
rclone ls r2:odyhook-backups | sort -r | head

# Run drift / digest jobs on demand
docker compose -f docker-compose.prod.yml exec -T web npm run job:drift
docker compose -f docker-compose.prod.yml exec -T web npm run job:digest

# Inspect actual env in the running container (sanity-check)
docker compose -f docker-compose.prod.yml exec web printenv | grep -E '^(AUTH_URL|NEXT_PUBLIC_APP_URL|EMAIL_FROM)'
```

## Recovery scenarios

### Site is down

1. SSH in, `docker compose ps`. Anything not `Up`?
2. If yes, check that container's logs.
3. Common cause: a deploy left containers restarting. `docker compose logs web` will show the error. Fix the code, push again.

### HTTPS broken / cert expired

Caddy auto-renews 30 days before expiry. If something genuinely went wrong:

```sh
docker compose -f docker-compose.prod.yml logs caddy | grep -i "error\|cert"
```

Common cause: DNS stopped pointing at the right IP. Confirm with `dig +short odyhook.dev` — should return `157.180.91.106`.

### Email stopped working

1. Check Resend dashboard → Domains. Did `odyhook.dev` revert to "Pending"? If so, DNS records at Porkbun likely got modified.
2. Check Resend → API Keys. Is the key still active?
3. Inspect runtime env: `docker compose exec web printenv | grep EMAIL`

### Lost the .env file

There's no off-site backup of `.env` currently (it lives only on the server). If the server is destroyed, you'd need to:

- Regenerate `AUTH_SECRET` (logs everyone out, not catastrophic)
- Regenerate `ENCRYPTION_KEY` — **this is catastrophic** because every encrypted DB column becomes unreadable. Consider periodically exporting `.env` to a password manager.
- Re-paste known values from external dashboards (Resend, R2, Sentry, GitHub OAuth)
- Re-generate `POSTGRES_PASSWORD` and re-apply to both `.env` AND the running Postgres user

### DB restore from R2

See "Backups → Restore procedure" above.

### Deploy key compromised

The deploy key can only run `odyhook-deploy.sh` — worst case is unauthorized redeploys of `main`. To rotate:

```sh
# On server
ssh-keygen -t ed25519 -f /root/.ssh/odyhook_deploy_new -N "" -q
# Replace the line in authorized_keys (keep the command= prefix)
# Update GitHub secret DEPLOY_SSH_KEY with the new private key
# Delete the old keypair
```

## What's intentionally NOT set up

These are *known gaps* — call out before assuming they exist:

- **No staging environment.** Pushes go straight to prod.
- **No CI tests before deploy.** A broken push will fail at the build step on the server but won't be caught earlier.
- **No off-site backup of `.env`.** See recovery scenario above.
- **No alerting on cron failures.** Cron output lands in a log file but nothing pages you if `job:backup` fails three nights in a row. Sentry would catch worker exceptions but not silent cron exit codes.
- **No HSTS preload, CSP, or hardening headers.** Caddy default config; could be tightened.

When adding new infrastructure, update this file in the same commit.
