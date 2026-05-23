# Odyhook — Disaster Recovery Procedures

Step-by-step for things going wrong. Skim the headings; deep-dive only what's actually broken. Every command assumes you've SSH'd in to `root@157.180.91.106` and are at `/opt/hooksmith` unless noted otherwise.

Pair this with [README.md](README.md) for context on what each component does.

---

## Site is down / not responding

### 1. Triage the containers

```sh
docker compose -f docker-compose.prod.yml ps
```

Each row should be `Up` (caddy/web/worker) or `Up (healthy)` (postgres/redis). Anything else is your culprit.

### 2. Read the failing container's logs

```sh
docker compose -f docker-compose.prod.yml logs --tail=100 <service>
```

| Pattern in logs | Likely cause |
|---|---|
| `Restarting (1) X seconds ago` | Container exits immediately on start. Usually a config/env error. |
| `prisma migrate deploy` failures | DB connection broken (Postgres down) OR `DATABASE_URL` wrong OR a bad migration |
| `EADDRINUSE` / `bind: address already in use` | Port collision. Some other process bound :80 / :443 / :3000 |
| Sentry init errors at startup | `SENTRY_DSN` malformed — but SDK is `enabled: !!dsn` so this should be rare |
| Connection refused to `postgres` or `redis` | Service name mismatch in `DATABASE_URL` / `REDIS_URL` — should be `postgres` / `redis`, not `localhost` |

### 3. Restart, force-recreate, or rebuild

```sh
# Easiest: kick the failing service
docker compose -f docker-compose.prod.yml restart web

# .env changed — needs new env, but no rebuild
docker compose -f docker-compose.prod.yml up -d --force-recreate web worker

# Dockerfile or build-time arg changed
docker compose -f docker-compose.prod.yml up -d --build
```

### 4. Last resort: nuke + rebuild

```sh
docker compose -f docker-compose.prod.yml down
docker compose -f docker-compose.prod.yml up -d --build
```

Volumes survive `down` — Postgres data is not lost.

**Do NOT run `docker compose down -v`** — the `-v` deletes named volumes including the DB.

---

## HTTPS broken / cert problems

Caddy auto-renews 30 days before expiry. If it's not, something's wrong.

### 1. Verify DNS still points at the server

```sh
dig +short odyhook.dev      # must return 157.180.91.106
dig +short www.odyhook.dev  # same
```

If wrong, fix at Porkbun (DNS section → A records). Wait 5–15 min for propagation.

### 2. Check Caddy logs for ACME errors

```sh
docker compose -f docker-compose.prod.yml logs --tail=50 caddy | grep -i "error\|cert\|acme"
```

Common errors:

- `unable to get challenge response`: port 80 isn't reachable from Let's Encrypt's servers. Check Hetzner Cloud Firewall rules.
- `too many failed authorizations`: Let's Encrypt rate limit (5 failures/hour). Wait an hour.
- `dns lookup failed`: DNS isn't propagated yet.

### 3. Force a cert renewal attempt

```sh
docker compose -f docker-compose.prod.yml restart caddy
```

On startup Caddy retries any expired/missing certs immediately.

### 4. Nuclear option: blow away Caddy's cert storage and restart

```sh
docker compose -f docker-compose.prod.yml down caddy
docker volume rm hooksmith_caddy_data hooksmith_caddy_config
docker compose -f docker-compose.prod.yml up -d caddy
```

Caddy will obtain fresh certs. **Only do this if** you've confirmed DNS is correct and ports 80/443 are reachable — otherwise you'll exhaust the Let's Encrypt rate limit and be locked out for ~a week.

---

## Email stopped working

Symptom: sign-in form submits but no magic-link email arrives.

### 1. Confirm domain is still verified in Resend

[https://resend.com/domains](https://resend.com/domains) → `odyhook.dev` status. Should be **Verified**.

If it flipped to **Pending**, the DKIM/SPF DNS records at Porkbun were modified or deleted. Restore them from the README's DNS table.

### 2. Inspect the actual env in the running container

```sh
docker compose -f docker-compose.prod.yml exec web printenv | grep -E '^EMAIL_'
```

Should print 5 vars including `EMAIL_SERVER_PASSWORD=re_...` and `EMAIL_FROM=Odyhook <no-reply@odyhook.dev>`.

If any are missing, the container didn't pick up `.env` — `docker compose up -d --force-recreate web worker`.

### 3. Check Resend dashboard for outgoing send attempts

[https://resend.com/emails](https://resend.com/emails) → recent activity. If sends are happening but bouncing, the recipient is rejecting; if they're failing with `5xx`, your DKIM/SPF is broken.

### 4. Test send from inside the web container

```sh
docker compose -f docker-compose.prod.yml exec -T web node -e "
const nodemailer = require('nodemailer');
const t = nodemailer.createTransport({
  host: process.env.EMAIL_SERVER_HOST,
  port: parseInt(process.env.EMAIL_SERVER_PORT),
  auth: { user: process.env.EMAIL_SERVER_USER, pass: process.env.EMAIL_SERVER_PASSWORD }
});
t.sendMail({
  from: process.env.EMAIL_FROM,
  to: 'YOUR_EMAIL_HERE',
  subject: 'Odyhook smoke test',
  text: 'If you see this, SMTP works.'
}).then(r => { console.log('sent:', r.messageId); process.exit(0); })
  .catch(e => { console.error(e); process.exit(1); });
"
```

If this fails with `authentication failed`, the Resend API key is wrong. Regenerate at Resend → API Keys, update `EMAIL_SERVER_PASSWORD` in `.env`, force-recreate.

---

## Postgres restore from R2

⚠️ **A restore overwrites the current DB.** Stop the web and worker first to prevent partial writes during restore.

### 1. List available backups

```sh
rclone ls r2:odyhook-backups | sort -k2 -r | head -15
```

Pick a timestamp. Backups are named `odyhook-YYYY-MM-DDTHH-MM-SSZ.sql.gz`.

### 2. Stop the app (DB stays up)

```sh
docker compose -f docker-compose.prod.yml stop web worker
```

### 3. Drop and recreate the schema

```sh
docker compose -f docker-compose.prod.yml exec postgres \
  psql -U hooksmith -d postgres -c "DROP DATABASE hooksmith;"
docker compose -f docker-compose.prod.yml exec postgres \
  psql -U hooksmith -d postgres -c "CREATE DATABASE hooksmith OWNER hooksmith;"
```

### 4. Pipe the backup directly into the new DB

```sh
BACKUP=odyhook-2026-05-23T07-32-44Z.sql.gz   # replace with the chosen file

rclone cat r2:odyhook-backups/$BACKUP \
  | gunzip \
  | docker compose -f docker-compose.prod.yml exec -T postgres \
      psql -U hooksmith -d hooksmith
```

### 5. Bring the app back up

```sh
docker compose -f docker-compose.prod.yml up -d web worker
```

### 6. Verify

```sh
docker compose -f docker-compose.prod.yml exec postgres \
  psql -U hooksmith -d hooksmith -c "SELECT COUNT(*) FROM \"User\"; SELECT COUNT(*) FROM \"Event\";"
```

Row counts should match what you expected for that backup's timestamp.

---

## Lost `.env` file

This is the scariest scenario. `.env` is gitignored, has no off-site backup, and contains values that cannot be recovered without consequences.

Severity per variable:

| Variable | If lost / regenerated |
|---|---|
| `NODE_ENV`, `POSTGRES_DB`, `REDIS_URL` | Trivial — re-derivable from this doc |
| `AUTH_SECRET` | Logs everyone out. Not catastrophic. `openssl rand -base64 32` |
| `AUTH_URL`, `NEXT_PUBLIC_APP_URL` | Re-derivable: `https://odyhook.dev` |
| `EMAIL_*` (SMTP creds) | Regenerate API key at Resend |
| `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET` | Regenerate at [github.com/settings/developers](https://github.com/settings/developers) → odyhook app |
| `SENTRY_DSN` | Visible in the Sentry dashboard, just paste it back |
| `POSTGRES_USER`, `POSTGRES_PASSWORD` | If the **volume still exists**, the Postgres role was provisioned at init from these vars and can't be re-derived — need to `ALTER USER` after spinning back up with a temp password. See "Lost Postgres password" below. |
| **`ENCRYPTION_KEY`** | **Catastrophic.** Encrypted columns become unrecoverable. See "Lost ENCRYPTION_KEY" below. |

### Lost Postgres password

If `POSTGRES_PASSWORD` is gone but the DB volume `hooksmith_odyhook_pg` survives:

```sh
# 1. Pick a new password
NEW_PW=$(openssl rand -hex 24)
echo "$NEW_PW"

# 2. Stop the app, keep postgres up
docker compose -f docker-compose.prod.yml stop web worker

# 3. Reset the role's password from inside the container
docker compose -f docker-compose.prod.yml exec postgres \
  psql -U postgres -c "ALTER USER hooksmith WITH PASSWORD '$NEW_PW';"

# 4. Write the new values to .env (replace placeholders)
nano .env
# POSTGRES_PASSWORD=<NEW_PW>
# DATABASE_URL=postgresql://hooksmith:<NEW_PW>@postgres:5432/hooksmith

# 5. Force-recreate so both app containers pick it up
docker compose -f docker-compose.prod.yml up -d --force-recreate web worker
```

### Lost `ENCRYPTION_KEY`

Encrypted DB columns:

- `Source.signingSecret` — webhook HMAC verification fails for those sources until a new secret is set per-source
- `Destination.headersEnc` — static headers (often bearer tokens) lost — destinations may start failing on auth checks at the receiving end
- `UserApiKey.anthropicKeyEnc` — users have to re-paste their Anthropic keys

There's no rewrap migration possible without the old key. Options:

1. **Take the loss.** Generate a new `ENCRYPTION_KEY`, NULL out the encrypted columns in the DB, ask users to re-enter signing secrets / destination headers / Anthropic keys.
2. **Restore from a backup taken before the loss** — but the backup would only have helped if you'd also backed up `.env`, which currently we don't.

**Mitigation (do this BEFORE this happens):** Periodically export `.env` to a password manager (1Password / Bitwarden / etc.). One copy of the file in a vault eliminates this entire failure mode.

---

## Deploy key compromised

`/root/.ssh/odyhook_deploy` private key leaked (e.g., from GitHub Actions logs).

The damage is limited — that key can ONLY run `/usr/local/bin/odyhook-deploy.sh` due to the `command=` restriction in `authorized_keys`. The worst an attacker can do is force-redeploy `main`. But still — rotate:

```sh
# On the server
cd /root/.ssh
ssh-keygen -t ed25519 -f odyhook_deploy_new -N "" -C "github-actions-deploy@odyhook" -q

# Replace the entry in authorized_keys
NEW_PUB=$(cat odyhook_deploy_new.pub)
sed -i "/github-actions-deploy@odyhook/d" /root/.ssh/authorized_keys
echo "command=\"/usr/local/bin/odyhook-deploy.sh\",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty $NEW_PUB" >> /root/.ssh/authorized_keys

# Update GitHub Actions secret
cat /root/.ssh/odyhook_deploy_new
# (locally, on your laptop, with gh CLI authed:)
# ssh root@157.180.91.106 'cat /root/.ssh/odyhook_deploy_new' | gh secret set DEPLOY_SSH_KEY --repo NikosGkikas13/hooksmith

# Once verified working, delete the old keypair
rm /root/.ssh/odyhook_deploy /root/.ssh/odyhook_deploy.pub
mv /root/.ssh/odyhook_deploy_new /root/.ssh/odyhook_deploy
mv /root/.ssh/odyhook_deploy_new.pub /root/.ssh/odyhook_deploy.pub
```

Push a no-op commit to verify the new key works.

---

## R2 credentials compromised

The R2 token is scoped to `Object Read & Write` on just the `odyhook-backups` bucket. Worst case: attacker uploads/deletes objects in that one bucket. Rotate:

1. [Cloudflare dashboard](https://dash.cloudflare.com) → R2 → Manage R2 API Tokens
2. Click the existing `odyhook-backup-writer` token → **Delete**
3. Create a new token with same settings (Object R/W, scoped to `odyhook-backups`)
4. SSH to server, edit `/root/.config/rclone/rclone.conf` (mode 600) — replace `access_key_id` and `secret_access_key`
5. Verify: `rclone ls r2:odyhook-backups | head`

If the attacker deleted backups, only the 14-day lifecycle window of files is affected — older backups would have been auto-deleted anyway.

---

## GitHub OAuth secret rotation

Standard practice every ~6 months or immediately if leaked:

1. [github.com/settings/developers](https://github.com/settings/developers) → OAuth Apps → Odyhook
2. **Generate a new client secret**. Copy it once.
3. SSH to server, edit `/opt/hooksmith/.env`:

   ```
   AUTH_GITHUB_SECRET=<new-value>
   ```

4. `docker compose -f docker-compose.prod.yml up -d --force-recreate web worker`
5. Sign in via GitHub once to verify
6. Back in GitHub OAuth settings, **delete the old secret** (it's still active until you do)

---

## Sentry DSN rotation

DSNs are essentially public (they're embedded in client bundles for many apps), so rotation is rare. Only do this if an attacker is spamming events:

1. [sentry.io](https://sentry.io) → Project `odyhook` → Settings → Client Keys (DSN)
2. **Create new key**, get new DSN
3. Update `SENTRY_DSN` in `.env`
4. `docker compose -f docker-compose.prod.yml up -d --force-recreate web worker`
5. Test with the one-off `Sentry.captureException` snippet in [README.md → Common operations](README.md#common-operations)
6. Disable the old client key in Sentry

---

## Domain rotation (moving away from odyhook.dev)

If you ever migrate to a new domain:

1. Buy + verify new domain (at any registrar)
2. Add new A records pointing at `157.180.91.106`
3. On the server: update `Caddyfile` (change `odyhook.dev` to new domain in both blocks)
4. Update `.env`: `AUTH_URL`, `NEXT_PUBLIC_APP_URL`
5. Update `EMAIL_FROM` if changing the sender domain → re-verify in Resend with new DKIM
6. `docker compose -f docker-compose.prod.yml up -d --build` (rebuild needed for `NEXT_PUBLIC_*`)
7. Update GitHub OAuth callback URL at [github.com/settings/developers](https://github.com/settings/developers)
8. Caddy obtains fresh Let's Encrypt cert automatically for the new domain

**Don't take down the old domain yet** — existing webhook senders are still hitting `https://odyhook.dev/api/ingest/<slug>`. Set up a redirect at the old domain to forward to the new ingest URL until all sources are migrated.

---

## Server migration (new VPS host)

E.g., moving off Hetzner. Plan:

1. Provision the new server, install Docker
2. **Take a manual backup** from the old server: `/usr/local/bin/odyhook-backup.sh`
3. Clone the repo on the new server: `git clone https://github.com/NikosGkikas13/hooksmith.git /opt/hooksmith`
4. Copy `.env` from old server to new (`scp`)
5. Copy `/root/.config/rclone/rclone.conf` (for backups)
6. Copy `/root/.ssh/odyhook_deploy*` (for CI deploys) — and update the SSH host key pin in the workflow YAML
7. Copy `/etc/cron.d/odyhook`
8. Copy `/usr/local/bin/odyhook-backup.sh` and `/usr/local/bin/odyhook-deploy.sh`
9. `docker compose -f docker-compose.prod.yml up -d --build` on new server
10. **Restore the DB** from R2 backup (procedure above)
11. Update Porkbun A records to new IP
12. Wait for DNS propagation, verify HTTPS works on new server
13. Once stable, decommission old server

---

## "Everything is gone and I have nothing but the GitHub repo"

You've lost the server entirely and `.env` was never backed up off-site. What you can rebuild:

| | |
|---|---|
| Codebase | `git clone` from GitHub |
| Rendered HTML/CSS | Re-build with `npm run build` |
| `AUTH_SECRET` | `openssl rand -base64 32` (logs out all existing users) |
| `ENCRYPTION_KEY` | `openssl rand -base64 32` (**all encrypted columns become unreadable**) |
| `EMAIL_SERVER_PASSWORD` | Regenerate in Resend dashboard |
| `AUTH_GITHUB_SECRET` | Regenerate in GitHub OAuth app settings |
| `SENTRY_DSN` | Visible in Sentry dashboard |
| R2 access key | Regenerate in Cloudflare dashboard |
| Database contents | **Restore from the most recent R2 backup** (assuming it's within the 14-day window) |
| User accounts | Restored from DB backup — but encrypted columns lost without `ENCRYPTION_KEY` |
| TLS certs | Caddy obtains fresh ones |

The DB backup + the codebase together get you 90% back. The unrecoverable 10%: encrypted column data (signing secrets, destination headers, user Anthropic keys). Users would need to re-enter those.

**The single biggest defense:** keep `.env` in a password manager. It's ~20 lines of text. Set a calendar reminder to re-export it whenever values rotate.
