# Real-time failure alerts — design

**Status:** approved 2026-05-25
**Tracks:** Odyhook competitor-gap plan item #6 (Tier 2)
**Predecessor:** circuit-breaker (PR #2, merged) already emails on destination auto-disable. This feature extends alerting with three new trigger types and two new channels.

---

## 1. Goal

Notify destination owners in real time when their downstream endpoints are unhealthy, so they can react before the weekly digest. Adds three trigger types and two channels on top of the existing destination-auto-disabled email.

**Non-goals:**

- Replacing the existing weekly digest.
- Replacing the existing destination-disabled email (kept as-is, always-on).
- Alerting on alert-send failures (no alert-on-alert; loops are worse than missed alerts).
- Per-channel "lastError" surfacing in the UI — deferred until users hit it.
- A "test" trigger that exercises every channel — covered by a per-channel "Send test alert" button instead.

---

## 2. Triggers (what fires an alert)

| Trigger | Fires when |
|---|---|
| `exhausted` | A delivery transitions to `exhausted` status (all 6 retries used up). |
| `failureRate` | After any delivery completion: of the last `windowCount` deliveries to this destination, ≥ `ratePct%` are `failed` or `exhausted`. Defaults: `windowCount = 20`, `ratePct = 50`. |
| `firstFailure` | A delivery fails (`failed` or `exhausted`) and the prior `afterSuccessCount` deliveries to this destination were all `delivered`. Default: `afterSuccessCount = 5`. |

The existing destination-auto-disabled email is independent — it always fires when the circuit breaker trips, regardless of this feature's config. It is not modeled as a trigger here.

---

## 3. Channels

| Channel | Transport |
|---|---|
| `email` | Existing `sendMail` (Nodemailer → Resend SMTP). Sent to `user.email`. |
| `slack` | POST blocks-formatted JSON to a user-supplied Slack incoming-webhook URL. |
| `webhook` | POST a JSON payload to a user-supplied URL with optional user-supplied headers. |

Slack URL and generic webhook URL+headers are encrypted at rest using the existing `ENCRYPTION_KEY` machinery (same pattern as `Destination.headersEnc` and `Destination.outboundSecretEnc`).

---

## 4. Configuration model

**Per-user defaults** (new column `User.alertConfigJson Json?`) and **per-destination override** (new column `Destination.alertConfigJson Json?`). Both are nullable; null means "no config" (and for the destination, "inherit user defaults entirely").

**Effective-config resolution:**

1. Start from a hard-coded default (all triggers off, no channels configured, `cooldownMinutes = 15`).
2. Shallow-merge `User.alertConfigJson` over the default.
3. Shallow-merge `Destination.alertConfigJson` over the result.

Merge is shallow per top-level key (`channels`, `triggers`) and shallow within each channel/trigger sub-object. Example: a destination override of `{ channels: { email: { enabled: false } } }` disables email for that destination only; Slack/webhook/triggers inherit from the user defaults.

**Validated shape (Zod):**

```ts
type AlertConfig = {
  channels: {
    email?:   { enabled: boolean };
    slack?:   { enabled: boolean; webhookUrlEnc: string };
    webhook?: { enabled: boolean; urlEnc: string; headersEnc?: string };
  };
  triggers: {
    exhausted?:    { enabled: boolean };
    failureRate?:  { enabled: boolean; ratePct: number; windowCount: number };
    firstFailure?: { enabled: boolean; afterSuccessCount: number };
  };
  cooldownMinutes?: number;
};
```

Zod constraints:

- `ratePct`: integer in `[1, 100]`.
- `windowCount`: integer in `[2, 200]`.
- `afterSuccessCount`: integer in `[1, 50]`.
- `cooldownMinutes`: integer in `[1, 1440]`.
- Slack URL must match `^https://hooks\.slack\.com/`.
- Generic webhook URL must be `https://` and not point to `NEXT_PUBLIC_APP_URL` host (basic self-loop guard).
- `headersEnc` decodes to a JSON object of string→string with ≤ 10 entries.

---

## 5. Architecture

Two new pieces inside the existing worker process tree:

- **`alerts` BullMQ queue** — Redis-backed, same Redis instance as the delivery queue.
- **Alert worker** — second `Worker` instance, booted from `src/workers/delivery.ts` `main()`. Same process, same Sentry, same logs.

```
delivery worker ──(decides "alert needed")──▶ alerts queue
                                                   │
                                                   ▼
                                            alert worker
                                                   │
                                       ┌───────────┼───────────┐
                                       ▼           ▼           ▼
                                    email       Slack    generic webhook
```

**Why same process:** zero deploy changes, no new compose service, no new container. The two `Worker`s share the event loop and Redis connection but not queue state. If the alert worker wedges, deliveries continue.

---

## 6. Files

```
src/lib/alerts/
  ├── index.ts         # maybeEnqueueAlerts() — called from delivery worker
  ├── config.ts        # resolveEffectiveConfig(userId, destinationId) → AlertConfig
  ├── triggers.ts      # pure: shouldFireExhausted/FailureRate/FirstFailure
  ├── cooldown.ts      # Redis SET NX EX claim per (destId, trigger)
  ├── compose.ts       # composeEmail/Slack/Webhook — pure formatters
  ├── dispatch.ts      # sendEmail/postSlack/postWebhook — I/O
  ├── queue.ts         # alertsQueue (BullMQ Queue) + AlertJob type
  ├── schema.ts        # Zod AlertConfig + encrypt/decrypt helpers
  └── *.test.ts        # vitest unit tests

src/workers/alerts.ts                    # Worker, called from delivery.ts main()
src/workers/delivery.ts                  # +call maybeEnqueueAlerts() after each completion

src/app/(dashboard)/settings/alerts/     # new page — account-wide defaults
  ├── page.tsx
  └── actions.ts                         # server actions: save, sendTest

src/app/(dashboard)/destinations/[id]/   # existing edit page — new "Alerts" section
  └── (modify in place)
```

Prisma migration:

```sql
ALTER TABLE "User" ADD COLUMN "alertConfigJson" JSONB;
ALTER TABLE "Destination" ADD COLUMN "alertConfigJson" JSONB;
```

No new tables, no new indexes (existing `Delivery [destinationId, status]` covers the rate query).

---

## 7. Data flow

### Delivery worker side

After every delivery completion (success and failure branches in `src/workers/delivery.ts`):

```ts
await maybeEnqueueAlerts({ destinationId, userId, deliveryOutcome });
```

`maybeEnqueueAlerts` (`src/lib/alerts/index.ts`):

1. Resolve effective config. If no triggers are enabled, return immediately.
2. For each enabled trigger, run its pure check:
   - `exhausted`: fire iff `deliveryOutcome.status === "exhausted"`.
   - `failureRate`: load last `windowCount` deliveries for `destinationId`, ordered by `createdAt desc`. If failed/exhausted count ≥ `ratePct%`, fire.
   - `firstFailure`: only consider failed outcomes. Load the prior `afterSuccessCount` deliveries (excluding this one); fire iff all are `delivered`. If fewer than `afterSuccessCount` priors exist, do not fire (no established "healthy" baseline to recover from).
3. For each fired trigger, `alertsQueue.add(triggerName, alertJob)` with `removeOnComplete: 1000, removeOnFail: 1000`.

### Alert worker side (`src/workers/alerts.ts`)

For each job:

1. `cooldown.tryClaim(destinationId, trigger, cooldownMinutes * 60)` — Redis `SET key NX EX seconds`. Key format: `alert:cooldown:<destId>:<trigger>`. If `NX` fails → ack and exit silently.
2. Re-resolve effective config (config may have changed between enqueue and process).
3. Decrypt channel secrets just-in-time.
4. Compose the message per channel via `compose.ts`.
5. Dispatch enabled channels in parallel via `Promise.allSettled`.
6. If **any** channel rejects → throw → BullMQ retries the whole job. Cooldown is *not* released. On retry, **all enabled channels run again**, including ones that succeeded on the prior attempt — accepted at-least-once duplication, since per-channel state tracking adds complexity for a rare path.
7. BullMQ retry: 3 attempts, exponential backoff 30s → 2m → 10m. After exhaustion, the job lands in the `failed` set; `Sentry.captureException` with `{ destinationId, trigger, channels }`.

### Cooldown semantics in detail

- Claimed *before* dispatch. Released only by Redis TTL expiry.
- Surviving a worker restart: the Redis key outlives the process.
- Trade-off: if all channels fail, the user gets no alert for that trigger until the cooldown expires. Documented as acceptable per the "no alert-on-alert" rule.
- Manual override: an admin can `redis-cli DEL alert:cooldown:<destId>:<trigger>` to force a re-fire on the next event.

---

## 8. UI

### `/settings/alerts` — new page

Account-wide defaults. Layout:

- **Channels** section. One card per channel.
  - **Email** — toggle. Displays `user.email` read-only.
  - **Slack** — toggle + Slack webhook URL field (placeholder: `https://hooks.slack.com/services/...`).
  - **Generic webhook** — toggle + URL field + optional headers JSON textarea.
  - "Send test alert" button on each enabled channel — server action calls `dispatch.ts` directly with a fixed sample payload, bypassing the queue, cooldown, and trigger logic. Does not use the `AlertJob` `trigger` enum.
- **Triggers** section. One card per trigger, each with a toggle and threshold inputs.
- **Cooldown** input at the bottom (default 15 minutes).
- "Save" persists via a server action with Zod validation and secret encryption.

### `/destinations/[id]/edit` — modify existing

New "Alerts" section. Radio:

- **Use account defaults** (default).
- **Custom for this destination** — same cards inline, pre-filled with the resolved effective config so users see what they're overriding.

---

## 9. Error handling

| Failure mode | Behavior |
|---|---|
| Channel dispatch throws | BullMQ retries job (3 attempts, exp backoff 30s/2m/10m). Cooldown stays claimed. |
| All retries exhausted | Job → Redis `failed` set. `Sentry.captureException`. No further user-facing alert. |
| Malformed `alertConfigJson` from DB | Zod parse fails → log warn, treat as "no config", continue. |
| Channel secret decryption fails | Log warn, skip that channel; other channels proceed. |
| Cooldown claim race (two workers, same trigger) | `SET NX` atomic; loser ack's silently. |
| Generic webhook loops back to Odyhook | Prevented at Zod validation. |
| Form submits invalid Slack URL or non-`https://` webhook | Zod rejection at the server action. |
| Destination deleted between enqueue and process | Worker re-resolves config → null → ack, drop. |

---

## 10. Testing

- **Unit (vitest):** `triggers.ts`, `cooldown.ts` (with `ioredis-mock`), `compose.ts`, `config.ts` (merge semantics), `schema.ts` (Zod boundary cases — invalid URLs, out-of-range thresholds, oversized headers).
- **Worker integration:** enqueue jobs against a real BullMQ in `docker compose` dev stack, mock the channel transports. Cover:
  - Cooldown hit → zero dispatch calls.
  - Cooldown miss → one dispatch call per enabled channel.
  - One channel throws → other channels still dispatched (`Promise.allSettled`).
  - Job retries respect cooldown (no double-fire on retry).
- **End-to-end smoke (manual, documented):** with `docker compose up -d`, point a destination at a deliberately broken URL, send 6 events to force an exhausted delivery, confirm the email lands in MailHog (`localhost:8025`) and a configured `webhook.site` URL receives the POST.

---

## 11. Out of scope (deliberate)

- Surfacing per-channel `lastAlertError` in the UI.
- A team/multi-user notion (one user → one config).
- Per-user PagerDuty / Discord / Teams native channels — covered by generic webhook.
- Alert history / audit log table.
- Webhook signing on outbound alert POSTs (use the existing optional auth headers field if needed).
- Alerts for source-side events (rate-limit hits, signature-verification failures). Different surface, different work.
