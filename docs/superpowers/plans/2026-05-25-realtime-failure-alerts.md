# Real-time Failure Alerts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Notify destination owners in real time on three new trigger types (exhausted delivery, sustained failure-rate, first-failure-after-recovery) over three channels (email, Slack incoming-webhook, generic webhook), with user-default + per-destination override config and Redis cooldown throttling.

**Architecture:** Two new pieces inside the existing worker process: an `odyhook.alerts` BullMQ queue and a second `Worker` instance booted from `src/workers/delivery.ts`. The delivery worker calls `maybeEnqueueAlerts()` after every completion; the alert worker claims a Redis cooldown key, re-resolves effective config, decrypts channel secrets, and dispatches enabled channels in parallel via `Promise.allSettled`. Config lives in two new JSON columns on `User` and `Destination`. Slack and generic-webhook URLs (plus optional generic-webhook headers) are AES-256-GCM-encrypted at rest using the existing `ENCRYPTION_KEY`.

**Tech Stack:** TypeScript, Next.js 16 App Router, Prisma 7, BullMQ 5, ioredis 5, Vitest 4, Nodemailer (Resend SMTP), Zod, AES-256-GCM (Node `crypto`).

**Spec:** [docs/superpowers/specs/2026-05-25-realtime-failure-alerts-design.md](../specs/2026-05-25-realtime-failure-alerts-design.md)

**Conventions in this codebase to mirror:**
- Tests touching Prisma load env via `import "dotenv/config"` (see `src/lib/circuit-breaker.test.ts`).
- BullMQ singletons lazy-init via `getConnection()` / `getDeliveryQueue()` in `src/lib/queue.ts`.
- Server actions live in `src/lib/actions/*.ts`, use `auth()` for session, Zod for validation, `revalidatePath()` at the end.
- Secrets stored as base64 AES-256-GCM payloads via `encrypt`/`encryptJson` from `src/lib/crypto.ts`.
- Pure compose functions in `src/lib/emails/*.ts` are unit-tested independent of SMTP, then `sendMail()` is called at the use site.
- Worker process is a single Node process — to add a second worker, instantiate another `new Worker()` in `src/workers/delivery.ts` (do NOT add a new container).

---

## File Structure (decided up front)

**Create:**

```
prisma/migrations/<timestamp>_alert_config/migration.sql

src/lib/alerts/
  schema.ts               # Zod AlertConfig + URL/host validators
  schema.test.ts
  config.ts               # resolveEffectiveConfig + shallow merge
  config.test.ts
  triggers.ts             # pure: shouldFire{Exhausted,FailureRate,FirstFailure}
  triggers.test.ts
  cooldown.ts             # Redis SET NX EX claim
  cooldown.test.ts
  compose.ts              # composeEmail/Slack/Webhook (pure formatters)
  compose.test.ts
  dispatch.ts             # sendAlertEmail/postSlack/postWebhook (I/O)
  queue.ts                # alertsQueue lazy singleton + AlertJob + AlertTrigger types
  index.ts                # maybeEnqueueAlerts() entrypoint

src/workers/alerts.ts     # Alert worker (booted from delivery.ts main)

src/lib/actions/alerts.ts # server actions: saveUserAlerts, saveDestinationAlerts, sendTestAlert, clearDestinationOverride

src/app/(dashboard)/settings/alerts/
  page.tsx                # account-wide defaults
  parts.tsx               # client-side controlled form (channels + triggers cards)

src/app/(dashboard)/destinations/[id]/
  page.tsx                # per-destination detail; hosts Alerts override section
```

**Modify:**

```
prisma/schema.prisma                       # +alertConfigJson columns on User + Destination
src/workers/delivery.ts                    # boot alerts Worker + call maybeEnqueueAlerts on success/failure/exhausted paths
src/app/(dashboard)/destinations/page.tsx  # link "Edit alerts" to the new detail page per row
src/components/nav-links.tsx               # add "Alerts" entry to the top nav array
```

Each `src/lib/alerts/*.ts` file has **one clear responsibility** so it can be unit-tested with no I/O dependencies (except `cooldown.ts` and `dispatch.ts`, which are the I/O seams).

---

## Task 1: Zod schema for `AlertConfig`

**Files:**
- Create: `src/lib/alerts/schema.ts`
- Test: `src/lib/alerts/schema.test.ts`

This is the type/contract foundation. Building it first means later tasks can import a stable shape. No DB, no I/O — pure Zod.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/alerts/schema.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  AlertConfigSchema,
  AlertTriggerSchema,
  DEFAULT_ALERT_CONFIG,
  validateSlackWebhookUrl,
  validateGenericWebhookUrl,
} from "./schema";

describe("AlertTriggerSchema", () => {
  it("accepts the three known trigger names", () => {
    for (const t of ["exhausted", "failureRate", "firstFailure"] as const) {
      expect(AlertTriggerSchema.parse(t)).toBe(t);
    }
  });

  it("rejects unknown trigger names", () => {
    expect(() => AlertTriggerSchema.parse("test")).toThrow();
    expect(() => AlertTriggerSchema.parse("")).toThrow();
  });
});

describe("AlertConfigSchema", () => {
  it("accepts the default config (all off, no channels)", () => {
    expect(AlertConfigSchema.parse(DEFAULT_ALERT_CONFIG)).toEqual(
      DEFAULT_ALERT_CONFIG,
    );
  });

  it("accepts a fully populated config", () => {
    const cfg = {
      channels: {
        email: { enabled: true },
        slack: { enabled: true, webhookUrlEnc: "ZW5jOnNsYWNr" },
        webhook: {
          enabled: true,
          urlEnc: "ZW5jOndlYmhvb2s=",
          headersEnc: "ZW5jOmhlYWRlcnM=",
        },
      },
      triggers: {
        exhausted: { enabled: true },
        failureRate: { enabled: true, ratePct: 50, windowCount: 20 },
        firstFailure: { enabled: true, afterSuccessCount: 5 },
      },
      cooldownMinutes: 30,
    };
    expect(AlertConfigSchema.parse(cfg)).toEqual(cfg);
  });

  it("rejects ratePct out of [1,100]", () => {
    const bad = {
      triggers: {
        failureRate: { enabled: true, ratePct: 0, windowCount: 20 },
      },
    };
    expect(() => AlertConfigSchema.parse(bad)).toThrow();
    expect(() =>
      AlertConfigSchema.parse({
        triggers: {
          failureRate: { enabled: true, ratePct: 101, windowCount: 20 },
        },
      }),
    ).toThrow();
  });

  it("rejects windowCount out of [2,200]", () => {
    expect(() =>
      AlertConfigSchema.parse({
        triggers: {
          failureRate: { enabled: true, ratePct: 50, windowCount: 1 },
        },
      }),
    ).toThrow();
    expect(() =>
      AlertConfigSchema.parse({
        triggers: {
          failureRate: { enabled: true, ratePct: 50, windowCount: 201 },
        },
      }),
    ).toThrow();
  });

  it("rejects afterSuccessCount out of [1,50]", () => {
    expect(() =>
      AlertConfigSchema.parse({
        triggers: { firstFailure: { enabled: true, afterSuccessCount: 0 } },
      }),
    ).toThrow();
    expect(() =>
      AlertConfigSchema.parse({
        triggers: { firstFailure: { enabled: true, afterSuccessCount: 51 } },
      }),
    ).toThrow();
  });

  it("rejects cooldownMinutes out of [1,1440]", () => {
    expect(() =>
      AlertConfigSchema.parse({ cooldownMinutes: 0 }),
    ).toThrow();
    expect(() =>
      AlertConfigSchema.parse({ cooldownMinutes: 1441 }),
    ).toThrow();
  });
});

describe("validateSlackWebhookUrl", () => {
  it("accepts an official Slack webhook URL", () => {
    expect(() =>
      validateSlackWebhookUrl(
        "https://hooks.slack.com/services/T000/B000/abcdef",
      ),
    ).not.toThrow();
  });

  it("rejects non-Slack URLs", () => {
    expect(() =>
      validateSlackWebhookUrl("https://example.com/webhook"),
    ).toThrow();
    expect(() =>
      validateSlackWebhookUrl("http://hooks.slack.com/services/x"),
    ).toThrow();
  });
});

describe("validateGenericWebhookUrl", () => {
  it("accepts an https URL on an unrelated host", () => {
    expect(() =>
      validateGenericWebhookUrl(
        "https://example.com/hook",
        "https://odyhook.dev",
      ),
    ).not.toThrow();
  });

  it("rejects non-https URLs", () => {
    expect(() =>
      validateGenericWebhookUrl(
        "http://example.com/hook",
        "https://odyhook.dev",
      ),
    ).toThrow();
  });

  it("rejects URLs whose host matches the app URL host (self-loop guard)", () => {
    expect(() =>
      validateGenericWebhookUrl(
        "https://odyhook.dev/api/ingest/x",
        "https://odyhook.dev",
      ),
    ).toThrow();
  });

  it("does not throw when appUrl is empty (dev / unconfigured)", () => {
    expect(() =>
      validateGenericWebhookUrl("https://example.com/hook", ""),
    ).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -- src/lib/alerts/schema.test.ts`
Expected: FAIL — module `./schema` does not exist.

- [ ] **Step 3: Implement `src/lib/alerts/schema.ts`**

```ts
import { z } from "zod";

export const ALERT_TRIGGERS = ["exhausted", "failureRate", "firstFailure"] as const;
export const AlertTriggerSchema = z.enum(ALERT_TRIGGERS);
export type AlertTrigger = z.infer<typeof AlertTriggerSchema>;

const EmailChannelSchema = z.object({
  enabled: z.boolean(),
});

const SlackChannelSchema = z.object({
  enabled: z.boolean(),
  // Stored encrypted; plaintext URL is never persisted. Server actions
  // validate the plaintext separately via validateSlackWebhookUrl before
  // encrypting.
  webhookUrlEnc: z.string().min(1),
});

const WebhookChannelSchema = z.object({
  enabled: z.boolean(),
  urlEnc: z.string().min(1),
  headersEnc: z.string().min(1).optional(),
});

const ChannelsSchema = z.object({
  email: EmailChannelSchema.optional(),
  slack: SlackChannelSchema.optional(),
  webhook: WebhookChannelSchema.optional(),
});

const TriggersSchema = z.object({
  exhausted: z.object({ enabled: z.boolean() }).optional(),
  failureRate: z
    .object({
      enabled: z.boolean(),
      ratePct: z.number().int().min(1).max(100),
      windowCount: z.number().int().min(2).max(200),
    })
    .optional(),
  firstFailure: z
    .object({
      enabled: z.boolean(),
      afterSuccessCount: z.number().int().min(1).max(50),
    })
    .optional(),
});

export const AlertConfigSchema = z
  .object({
    channels: ChannelsSchema.optional(),
    triggers: TriggersSchema.optional(),
    cooldownMinutes: z.number().int().min(1).max(1440).optional(),
  })
  .strict();

export type AlertConfig = z.infer<typeof AlertConfigSchema>;

export const DEFAULT_ALERT_CONFIG: AlertConfig = {
  channels: {},
  triggers: {},
  cooldownMinutes: 15,
};

const SLACK_WEBHOOK_RE = /^https:\/\/hooks\.slack\.com\//;

export function validateSlackWebhookUrl(url: string): void {
  if (!SLACK_WEBHOOK_RE.test(url)) {
    throw new Error(
      "Slack webhook URL must start with https://hooks.slack.com/",
    );
  }
}

export function validateGenericWebhookUrl(url: string, appUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Webhook URL is not a valid URL");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("Webhook URL must use https://");
  }
  if (appUrl) {
    let appHost: string;
    try {
      appHost = new URL(appUrl).host;
    } catch {
      appHost = "";
    }
    if (appHost && parsed.host === appHost) {
      throw new Error(
        "Webhook URL must not point back at Odyhook itself (would loop)",
      );
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -- src/lib/alerts/schema.test.ts`
Expected: PASS (all assertions green).

- [ ] **Step 5: Commit**

```bash
git add src/lib/alerts/schema.ts src/lib/alerts/schema.test.ts
git commit -m "feat(alerts): Zod schema + URL validators for AlertConfig"
```

---

## Task 2: Prisma migration — add `alertConfigJson` to User and Destination

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_alert_config/migration.sql` (auto-generated)

- [ ] **Step 1: Modify `prisma/schema.prisma`**

Add `alertConfigJson Json?` to the `User` model. Find the `User` block and replace the relations section to include the new field:

```prisma
model User {
  id            String    @id @default(cuid())
  name          String?
  email         String    @unique
  emailVerified DateTime?
  image         String?
  createdAt     DateTime  @default(now())
  // Account-wide alert defaults. Nullable = no defaults configured.
  // Per-destination overrides on Destination.alertConfigJson shallow-merge
  // on top of this. See src/lib/alerts/schema.ts for the shape.
  alertConfigJson Json?

  accounts     Account[]
  sessions     Session[]
  sources      Source[]
  destinations Destination[]
  apiKey       UserApiKey?
}
```

Add `alertConfigJson Json?` to the `Destination` model, just after `autoDisabledReason`:

```prisma
  // Operational pause. When false, ingest skips creating deliveries for this
  // destination and the worker refuses to deliver any already-enqueued job.
  enabled             Boolean   @default(true)
  // ... existing fields ...
  autoDisabledReason  String?
  // Per-destination alert override. Partial shape — keys present here win
  // over User.alertConfigJson during effective-config resolution. Null =
  // inherit user defaults entirely. See src/lib/alerts/schema.ts.
  alertConfigJson     Json?
  createdAt   DateTime @default(now())
```

- [ ] **Step 2: Generate the migration**

Run: `npm run db:migrate -- --name alert_config`
Expected: Prisma creates a new migration folder under `prisma/migrations/<timestamp>_alert_config/` with a `migration.sql` containing two `ALTER TABLE ... ADD COLUMN "alertConfigJson" JSONB` statements, then applies it to the dev DB and regenerates the client to `src/generated/prisma/`.

If `docker compose` isn't already running, start it first: `docker compose up -d postgres redis mailhog`.

- [ ] **Step 3: Verify the columns exist**

Run: `docker compose exec postgres psql -U hooksmith hooksmith -c '\d "User"' | grep alertConfigJson`
Expected output includes a line like: `alertConfigJson | jsonb |`.

Run: `docker compose exec postgres psql -U hooksmith hooksmith -c '\d "Destination"' | grep alertConfigJson`
Expected output: same.

- [ ] **Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: zero errors (the regenerated Prisma client now exposes `alertConfigJson` on the model types).

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/ src/generated/prisma/
git commit -m "feat(alerts): add alertConfigJson columns on User and Destination"
```

---

## Task 3: Effective-config resolution (`config.ts`)

**Files:**
- Create: `src/lib/alerts/config.ts`
- Test: `src/lib/alerts/config.test.ts`

Pure shallow-merge logic — no DB calls in this file. The Prisma read lives in a thin wrapper at the call site (or `index.ts`). This keeps merge logic unit-testable.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/alerts/config.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mergeAlertConfigs } from "./config";
import { DEFAULT_ALERT_CONFIG, type AlertConfig } from "./schema";

describe("mergeAlertConfigs", () => {
  it("returns the default when both inputs are null", () => {
    expect(mergeAlertConfigs(null, null)).toEqual(DEFAULT_ALERT_CONFIG);
  });

  it("falls back to user defaults when destination override is null", () => {
    const user: AlertConfig = {
      channels: { email: { enabled: true } },
      triggers: { exhausted: { enabled: true } },
      cooldownMinutes: 30,
    };
    expect(mergeAlertConfigs(user, null)).toEqual({
      channels: { email: { enabled: true } },
      triggers: { exhausted: { enabled: true } },
      cooldownMinutes: 30,
    });
  });

  it("destination override wins on a per-channel basis", () => {
    const user: AlertConfig = {
      channels: {
        email: { enabled: true },
        slack: { enabled: true, webhookUrlEnc: "USER_SLACK" },
      },
      triggers: {},
    };
    const dest: AlertConfig = {
      channels: { email: { enabled: false } },
    };
    const merged = mergeAlertConfigs(user, dest);
    expect(merged.channels?.email).toEqual({ enabled: false });
    // Slack inherited unchanged from user.
    expect(merged.channels?.slack).toEqual({
      enabled: true,
      webhookUrlEnc: "USER_SLACK",
    });
  });

  it("destination override wins on a per-trigger basis", () => {
    const user: AlertConfig = {
      triggers: {
        exhausted: { enabled: true },
        firstFailure: { enabled: true, afterSuccessCount: 5 },
      },
    };
    const dest: AlertConfig = {
      triggers: { exhausted: { enabled: false } },
    };
    const merged = mergeAlertConfigs(user, dest);
    expect(merged.triggers?.exhausted).toEqual({ enabled: false });
    expect(merged.triggers?.firstFailure).toEqual({
      enabled: true,
      afterSuccessCount: 5,
    });
  });

  it("destination cooldownMinutes overrides user cooldownMinutes", () => {
    expect(
      mergeAlertConfigs(
        { cooldownMinutes: 60 },
        { cooldownMinutes: 5 },
      ).cooldownMinutes,
    ).toBe(5);
  });

  it("falls back to DEFAULT cooldownMinutes when neither sets it", () => {
    expect(mergeAlertConfigs({ channels: {} }, null).cooldownMinutes).toBe(15);
  });

  it("silently ignores malformed JSON (returns default)", () => {
    // mergeAlertConfigs is called with the result of parseStoredConfig;
    // parseStoredConfig returns null on parse failure.
    expect(mergeAlertConfigs(null, null)).toEqual(DEFAULT_ALERT_CONFIG);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -- src/lib/alerts/config.test.ts`
Expected: FAIL — module `./config` does not exist.

- [ ] **Step 3: Implement `src/lib/alerts/config.ts`**

```ts
import { AlertConfigSchema, DEFAULT_ALERT_CONFIG, type AlertConfig } from "./schema";

/**
 * Parse a JSON column value (from Prisma) into a validated AlertConfig.
 * Returns null on null input or validation failure — never throws.
 */
export function parseStoredConfig(value: unknown): AlertConfig | null {
  if (value == null) return null;
  const result = AlertConfigSchema.safeParse(value);
  if (!result.success) {
    console.warn("[alerts] discarding malformed alertConfigJson:", result.error.message);
    return null;
  }
  return result.data;
}

/**
 * Shallow-merge per top-level key, with destination override taking
 * precedence on a per-channel and per-trigger basis. cooldownMinutes is
 * a scalar override.
 */
export function mergeAlertConfigs(
  user: AlertConfig | null,
  destination: AlertConfig | null,
): AlertConfig {
  const out: AlertConfig = {
    channels: { ...user?.channels, ...destination?.channels },
    triggers: { ...user?.triggers, ...destination?.triggers },
    cooldownMinutes:
      destination?.cooldownMinutes ??
      user?.cooldownMinutes ??
      DEFAULT_ALERT_CONFIG.cooldownMinutes,
  };
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -- src/lib/alerts/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/alerts/config.ts src/lib/alerts/config.test.ts
git commit -m "feat(alerts): effective-config resolution with shallow per-key merge"
```

---

## Task 4: Trigger logic (`triggers.ts`)

**Files:**
- Create: `src/lib/alerts/triggers.ts`
- Test: `src/lib/alerts/triggers.test.ts`

Three pure decision functions. They take config + a slice of recent delivery history; no DB calls. The DB query happens in `index.ts` (Task 11).

- [ ] **Step 1: Write the failing tests**

Create `src/lib/alerts/triggers.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  shouldFireExhausted,
  shouldFireFailureRate,
  shouldFireFirstFailure,
  type DeliveryHistoryRow,
} from "./triggers";

const ok = (id: string): DeliveryHistoryRow => ({ id, status: "delivered" });
const fail = (id: string): DeliveryHistoryRow => ({ id, status: "exhausted" });

describe("shouldFireExhausted", () => {
  it("fires when the trigger is enabled and the outcome is exhausted", () => {
    expect(
      shouldFireExhausted(
        { enabled: true },
        { status: "exhausted" },
      ),
    ).toBe(true);
  });

  it("does not fire when the trigger is disabled", () => {
    expect(
      shouldFireExhausted(undefined, { status: "exhausted" }),
    ).toBe(false);
    expect(
      shouldFireExhausted({ enabled: false }, { status: "exhausted" }),
    ).toBe(false);
  });

  it("does not fire when the outcome is delivered", () => {
    expect(
      shouldFireExhausted({ enabled: true }, { status: "delivered" }),
    ).toBe(false);
  });

  it("does not fire on intermediate 'failed' status (only terminal exhausted)", () => {
    expect(
      shouldFireExhausted({ enabled: true }, { status: "failed" }),
    ).toBe(false);
  });
});

describe("shouldFireFailureRate", () => {
  const cfg = { enabled: true, ratePct: 50, windowCount: 4 } as const;

  it("does not fire when disabled", () => {
    expect(
      shouldFireFailureRate(undefined, [fail("a"), fail("b")]),
    ).toBe(false);
  });

  it("does not fire when the window has fewer than windowCount rows", () => {
    expect(shouldFireFailureRate(cfg, [fail("a")])).toBe(false);
    expect(shouldFireFailureRate(cfg, [fail("a"), fail("b"), fail("c")])).toBe(
      false,
    );
  });

  it("fires when failures meet the threshold", () => {
    expect(
      shouldFireFailureRate(cfg, [fail("a"), fail("b"), ok("c"), ok("d")]),
    ).toBe(true);
  });

  it("does not fire when below the threshold", () => {
    expect(
      shouldFireFailureRate(cfg, [fail("a"), ok("b"), ok("c"), ok("d")]),
    ).toBe(false);
  });

  it("counts both 'failed' and 'exhausted' as failures", () => {
    const mixed: DeliveryHistoryRow[] = [
      { id: "1", status: "failed" },
      { id: "2", status: "exhausted" },
      { id: "3", status: "delivered" },
      { id: "4", status: "delivered" },
    ];
    expect(shouldFireFailureRate(cfg, mixed)).toBe(true);
  });
});

describe("shouldFireFirstFailure", () => {
  const cfg = { enabled: true, afterSuccessCount: 3 } as const;

  it("does not fire when disabled", () => {
    expect(
      shouldFireFirstFailure(
        undefined,
        { status: "exhausted" },
        [ok("a"), ok("b"), ok("c")],
      ),
    ).toBe(false);
  });

  it("does not fire when the current outcome is delivered", () => {
    expect(
      shouldFireFirstFailure(
        cfg,
        { status: "delivered" },
        [ok("a"), ok("b"), ok("c")],
      ),
    ).toBe(false);
  });

  it("fires when the current outcome is exhausted and prior N are all delivered", () => {
    expect(
      shouldFireFirstFailure(
        cfg,
        { status: "exhausted" },
        [ok("a"), ok("b"), ok("c")],
      ),
    ).toBe(true);
  });

  it("fires when the current outcome is failed and prior N are all delivered", () => {
    expect(
      shouldFireFirstFailure(
        cfg,
        { status: "failed" },
        [ok("a"), ok("b"), ok("c")],
      ),
    ).toBe(true);
  });

  it("does not fire when fewer than afterSuccessCount priors exist", () => {
    expect(
      shouldFireFirstFailure(
        cfg,
        { status: "exhausted" },
        [ok("a"), ok("b")],
      ),
    ).toBe(false);
  });

  it("does not fire when any prior is a failure", () => {
    expect(
      shouldFireFirstFailure(
        cfg,
        { status: "exhausted" },
        [ok("a"), fail("b"), ok("c")],
      ),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -- src/lib/alerts/triggers.test.ts`
Expected: FAIL — module `./triggers` does not exist.

- [ ] **Step 3: Implement `src/lib/alerts/triggers.ts`**

```ts
import type { AlertConfig } from "./schema";

// Minimal slice of a Delivery row that the trigger functions need. Kept
// narrow so the pure-function layer doesn't depend on Prisma types.
export type DeliveryStatus =
  | "pending"
  | "in_flight"
  | "delivered"
  | "failed"
  | "exhausted";

export type DeliveryHistoryRow = {
  id: string;
  status: DeliveryStatus;
};

export type CurrentOutcome = {
  status: DeliveryStatus;
};

function isFailure(s: DeliveryStatus): boolean {
  return s === "failed" || s === "exhausted";
}

export function shouldFireExhausted(
  cfg: AlertConfig["triggers"] extends infer T
    ? T extends { exhausted?: infer E }
      ? E
      : undefined
    : undefined,
  outcome: CurrentOutcome,
): boolean {
  if (!cfg?.enabled) return false;
  return outcome.status === "exhausted";
}

export function shouldFireFailureRate(
  cfg: AlertConfig["triggers"] extends infer T
    ? T extends { failureRate?: infer F }
      ? F
      : undefined
    : undefined,
  history: DeliveryHistoryRow[],
): boolean {
  if (!cfg?.enabled) return false;
  if (history.length < cfg.windowCount) return false;
  const window = history.slice(0, cfg.windowCount);
  const failures = window.filter((r) => isFailure(r.status)).length;
  const pct = (failures / window.length) * 100;
  return pct >= cfg.ratePct;
}

export function shouldFireFirstFailure(
  cfg: AlertConfig["triggers"] extends infer T
    ? T extends { firstFailure?: infer F }
      ? F
      : undefined
    : undefined,
  outcome: CurrentOutcome,
  priorHistory: DeliveryHistoryRow[],
): boolean {
  if (!cfg?.enabled) return false;
  if (!isFailure(outcome.status)) return false;
  if (priorHistory.length < cfg.afterSuccessCount) return false;
  const window = priorHistory.slice(0, cfg.afterSuccessCount);
  return window.every((r) => r.status === "delivered");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -- src/lib/alerts/triggers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/alerts/triggers.ts src/lib/alerts/triggers.test.ts
git commit -m "feat(alerts): pure trigger decisions for exhausted/rate/firstFailure"
```

---

## Task 5: Compose layer (`compose.ts`)

**Files:**
- Create: `src/lib/alerts/compose.ts`
- Test: `src/lib/alerts/compose.test.ts`

Pure formatters. Same pattern as `src/lib/emails/destination-disabled.ts`.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/alerts/compose.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  composeEmail,
  composeSlackBlocks,
  composeWebhookPayload,
  type AlertContext,
} from "./compose";

const baseCtx: AlertContext = {
  destinationName: "Billing prod",
  destinationId: "dst_abc",
  trigger: "exhausted",
  deliveryId: "del_xyz",
  lastError: "HTTP 500",
};

describe("composeEmail", () => {
  const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL;
  beforeAll(() => {
    process.env.NEXT_PUBLIC_APP_URL = "https://odyhook.dev";
  });
  afterAll(() => {
    if (originalAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = originalAppUrl;
  });

  it("includes destination name in the subject", () => {
    const msg = composeEmail(baseCtx);
    expect(msg.subject).toContain("Billing prod");
  });

  it("includes trigger label and link to the destination page", () => {
    const msg = composeEmail(baseCtx);
    expect(msg.text).toContain("exhausted");
    expect(msg.text).toContain("https://odyhook.dev/destinations/dst_abc");
  });

  it("strips CR/LF from destinationName before putting it in the subject", () => {
    const msg = composeEmail({
      ...baseCtx,
      destinationName: "Bad\r\nSubject: injected",
    });
    expect(msg.subject).not.toMatch(/[\r\n]/);
  });

  it("truncates an oversized lastError", () => {
    const msg = composeEmail({ ...baseCtx, lastError: "x".repeat(1000) });
    expect(msg.text.length).toBeLessThan(2000);
  });
});

describe("composeSlackBlocks", () => {
  it("returns Block Kit JSON with the trigger and destination name", () => {
    const blocks = composeSlackBlocks(baseCtx);
    const txt = JSON.stringify(blocks);
    expect(txt).toContain("Billing prod");
    expect(txt).toContain("exhausted");
  });
});

describe("composeWebhookPayload", () => {
  it("returns a stable JSON shape with all context fields", () => {
    const payload = composeWebhookPayload(baseCtx);
    expect(payload).toMatchObject({
      event: "alert",
      trigger: "exhausted",
      destination: { id: "dst_abc", name: "Billing prod" },
      deliveryId: "del_xyz",
      lastError: "HTTP 500",
    });
    expect(typeof payload.firedAt).toBe("string");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -- src/lib/alerts/compose.test.ts`
Expected: FAIL — module `./compose` does not exist.

- [ ] **Step 3: Implement `src/lib/alerts/compose.ts`**

```ts
import type { AlertTrigger } from "./schema";

export type AlertContext = {
  destinationName: string;
  destinationId: string;
  trigger: AlertTrigger;
  deliveryId: string;
  lastError?: string;
  // Optional, populated for failureRate:
  failureCount?: number;
  windowSize?: number;
  // Optional, populated for firstFailure:
  afterSuccesses?: number;
};

const TRIGGER_LABEL: Record<AlertTrigger, string> = {
  exhausted: "exhausted (all retries used)",
  failureRate: "high failure rate",
  firstFailure: "first failure after recovery",
};

function sanitizeForSubject(s: string): string {
  return s.replace(/[\r\n\f]/g, "");
}

export type ComposedEmail = { subject: string; text: string };

export function composeEmail(ctx: AlertContext): ComposedEmail {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
  const link = baseUrl
    ? `${baseUrl}/destinations/${ctx.destinationId}`
    : `/destinations/${ctx.destinationId}`;
  const safeName = sanitizeForSubject(ctx.destinationName);
  const reason = (ctx.lastError ?? "").slice(0, 300);
  const detailLines: string[] = [];
  if (ctx.failureCount != null && ctx.windowSize != null) {
    detailLines.push(
      `Failures: ${ctx.failureCount} of the last ${ctx.windowSize} deliveries.`,
    );
  }
  if (ctx.afterSuccesses != null) {
    detailLines.push(
      `This destination delivered ${ctx.afterSuccesses} events successfully before this failure.`,
    );
  }
  if (reason) detailLines.push(`Last error: ${reason}`);

  return {
    subject: `Odyhook: ${TRIGGER_LABEL[ctx.trigger]} on "${safeName}"`,
    text: [
      `Heads up — Odyhook detected ${TRIGGER_LABEL[ctx.trigger]} on your destination "${safeName}".`,
      "",
      ...detailLines,
      "",
      `Inspect or pause it here: ${link}`,
    ]
      .filter((line, i, arr) => !(line === "" && arr[i - 1] === ""))
      .join("\n"),
  };
}

export type SlackBlocks = {
  blocks: Array<Record<string, unknown>>;
};

export function composeSlackBlocks(ctx: AlertContext): SlackBlocks {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
  const link = baseUrl
    ? `${baseUrl}/destinations/${ctx.destinationId}`
    : `/destinations/${ctx.destinationId}`;
  const fields: Array<{ type: "mrkdwn"; text: string }> = [];
  if (ctx.failureCount != null && ctx.windowSize != null) {
    fields.push({
      type: "mrkdwn",
      text: `*Failures:* ${ctx.failureCount}/${ctx.windowSize}`,
    });
  }
  if (ctx.afterSuccesses != null) {
    fields.push({
      type: "mrkdwn",
      text: `*Prior successes:* ${ctx.afterSuccesses}`,
    });
  }
  if (ctx.lastError) {
    fields.push({
      type: "mrkdwn",
      text: `*Last error:* \`${ctx.lastError.slice(0, 200)}\``,
    });
  }
  return {
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `Odyhook: ${TRIGGER_LABEL[ctx.trigger]}`,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Destination:* <${link}|${ctx.destinationName}>`,
        },
        ...(fields.length ? { fields } : {}),
      },
    ],
  };
}

export type WebhookPayload = {
  event: "alert";
  trigger: AlertTrigger;
  destination: { id: string; name: string };
  deliveryId: string;
  lastError?: string;
  failureCount?: number;
  windowSize?: number;
  afterSuccesses?: number;
  firedAt: string;
};

export function composeWebhookPayload(ctx: AlertContext): WebhookPayload {
  return {
    event: "alert",
    trigger: ctx.trigger,
    destination: { id: ctx.destinationId, name: ctx.destinationName },
    deliveryId: ctx.deliveryId,
    lastError: ctx.lastError,
    failureCount: ctx.failureCount,
    windowSize: ctx.windowSize,
    afterSuccesses: ctx.afterSuccesses,
    firedAt: new Date().toISOString(),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -- src/lib/alerts/compose.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/alerts/compose.ts src/lib/alerts/compose.test.ts
git commit -m "feat(alerts): compose email/Slack/webhook payloads"
```

---

## Task 6: Cooldown claim (`cooldown.ts`)

**Files:**
- Create: `src/lib/alerts/cooldown.ts`
- Test: `src/lib/alerts/cooldown.test.ts`

Hits the real local Redis (per existing convention — see `src/lib/ratelimit.ts` and `src/lib/circuit-breaker.test.ts`).

- [ ] **Step 1: Write the failing tests**

Create `src/lib/alerts/cooldown.test.ts`:

```ts
import "dotenv/config";

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getConnection } from "../queue";
import { tryClaimCooldown, cooldownKey } from "./cooldown";

const redis = getConnection();

async function clear(destId: string, trigger: "exhausted" | "failureRate" | "firstFailure") {
  await redis.del(cooldownKey(destId, trigger));
}

describe("tryClaimCooldown", () => {
  const destId = `cool-${Date.now()}`;

  beforeEach(async () => {
    await clear(destId, "exhausted");
  });

  afterAll(async () => {
    await clear(destId, "exhausted");
  });

  it("returns true the first time and false the second time within TTL", async () => {
    const first = await tryClaimCooldown(destId, "exhausted", 60);
    const second = await tryClaimCooldown(destId, "exhausted", 60);
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it("allows a new claim after the TTL expires", async () => {
    // 1s TTL is short enough to wait through in a test.
    await tryClaimCooldown(destId, "exhausted", 1);
    await new Promise((r) => setTimeout(r, 1100));
    const after = await tryClaimCooldown(destId, "exhausted", 60);
    expect(after).toBe(true);
  });

  it("scopes claims independently per trigger", async () => {
    await tryClaimCooldown(destId, "exhausted", 60);
    const otherTrigger = await tryClaimCooldown(destId, "failureRate", 60);
    expect(otherTrigger).toBe(true);
    await clear(destId, "failureRate");
  });
});

describe("cooldownKey", () => {
  it("produces a stable, namespaced key", () => {
    expect(cooldownKey("dst_abc", "exhausted")).toBe(
      "alert:cooldown:dst_abc:exhausted",
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -- src/lib/alerts/cooldown.test.ts`
Expected: FAIL — module `./cooldown` does not exist.

Ensure Redis is running: `docker compose up -d redis`.

- [ ] **Step 3: Implement `src/lib/alerts/cooldown.ts`**

```ts
import { getConnection } from "../queue";
import type { AlertTrigger } from "./schema";

export function cooldownKey(destinationId: string, trigger: AlertTrigger): string {
  return `alert:cooldown:${destinationId}:${trigger}`;
}

/**
 * Atomically claim a per-(destination, trigger) cooldown for the next
 * `ttlSec` seconds. Returns true if the claim was won (caller should
 * proceed to dispatch), false if a prior claim is still live.
 *
 * Implemented via `SET key NX EX`, which is atomic across concurrent
 * workers. The claim is *not* released on dispatch failure — see
 * the design doc §7 "Cooldown semantics".
 */
export async function tryClaimCooldown(
  destinationId: string,
  trigger: AlertTrigger,
  ttlSec: number,
): Promise<boolean> {
  const key = cooldownKey(destinationId, trigger);
  const result = await getConnection().set(key, "1", "EX", ttlSec, "NX");
  return result === "OK";
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -- src/lib/alerts/cooldown.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/alerts/cooldown.ts src/lib/alerts/cooldown.test.ts
git commit -m "feat(alerts): Redis cooldown claim per (destination, trigger)"
```

---

## Task 7: Dispatch layer (`dispatch.ts`)

**Files:**
- Create: `src/lib/alerts/dispatch.ts`

I/O. Three thin functions: email (delegates to `sendMail`), Slack (POST blocks), generic webhook (POST JSON). No unit tests for this file directly — covered end-to-end in Task 11 (`maybeEnqueueAlerts`) and the manual smoke in Task 16. Keep it focused so behavior is obvious from reading.

- [ ] **Step 1: Implement `src/lib/alerts/dispatch.ts`**

```ts
import { sendMail } from "../mailer";
import { decrypt, decryptJson } from "../crypto";
import { composeEmail, composeSlackBlocks, composeWebhookPayload, type AlertContext } from "./compose";

const SLACK_TIMEOUT_MS = 10_000;
const WEBHOOK_TIMEOUT_MS = 10_000;

export async function dispatchEmail(to: string, ctx: AlertContext): Promise<void> {
  const msg = composeEmail(ctx);
  await sendMail({ to, subject: msg.subject, text: msg.text });
}

export async function dispatchSlack(
  webhookUrlEnc: string,
  ctx: AlertContext,
): Promise<void> {
  const url = decrypt(webhookUrlEnc);
  const body = composeSlackBlocks(ctx);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SLACK_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Slack POST ${res.status}: ${text.slice(0, 200)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function dispatchGenericWebhook(
  urlEnc: string,
  headersEnc: string | undefined,
  ctx: AlertContext,
): Promise<void> {
  const url = decrypt(urlEnc);
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (headersEnc) {
    try {
      const decoded = decryptJson<Record<string, string>>(headersEnc);
      for (const [k, v] of Object.entries(decoded)) {
        headers[k] = v;
      }
    } catch (err) {
      console.warn("[alerts] failed to decrypt webhook headers:", err);
    }
  }
  const payload = composeWebhookPayload(ctx);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Webhook POST ${res.status}`);
    }
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/alerts/dispatch.ts
git commit -m "feat(alerts): email/Slack/webhook dispatch with 10s timeouts"
```

---

## Task 8: Alerts queue (`queue.ts`)

**Files:**
- Create: `src/lib/alerts/queue.ts`

- [ ] **Step 1: Implement `src/lib/alerts/queue.ts`**

```ts
import { Queue } from "bullmq";
import { getConnection } from "../queue";
import type { AlertTrigger } from "./schema";

export const ALERTS_QUEUE = "odyhook.alerts";

export type AlertJob = {
  destinationId: string;
  trigger: AlertTrigger;
  deliveryId: string;
  lastError?: string;
  failureCount?: number;
  windowSize?: number;
  afterSuccesses?: number;
};

let _alertsQueue: Queue<AlertJob> | null = null;

export function getAlertsQueue(): Queue<AlertJob> {
  if (!_alertsQueue) {
    _alertsQueue = new Queue<AlertJob>(ALERTS_QUEUE, {
      connection: getConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 30_000 },
        removeOnComplete: 1000,
        removeOnFail: 1000,
      },
    });
  }
  return _alertsQueue;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/alerts/queue.ts
git commit -m "feat(alerts): BullMQ queue with 3 attempts + exp backoff (30s/2m/10m)"
```

---

## Task 9: Alert worker (`src/workers/alerts.ts`)

**Files:**
- Create: `src/workers/alerts.ts`
- Test: `src/workers/alerts.test.ts`

Integration test enqueues a real job and asserts the dispatch functions are called. `sendMail` and `fetch` are stubbed.

- [ ] **Step 1: Write the failing tests**

Create `src/workers/alerts.test.ts`:

```ts
import "dotenv/config";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../lib/prisma";
import { getConnection } from "../lib/queue";
import { getAlertsQueue, ALERTS_QUEUE } from "../lib/alerts/queue";
import { cooldownKey } from "../lib/alerts/cooldown";
import { encrypt, encryptJson } from "../lib/crypto";

// Hoist mocks: dispatch is the I/O seam.
vi.mock("../lib/alerts/dispatch", () => ({
  dispatchEmail: vi.fn().mockResolvedValue(undefined),
  dispatchSlack: vi.fn().mockResolvedValue(undefined),
  dispatchGenericWebhook: vi.fn().mockResolvedValue(undefined),
}));

import {
  dispatchEmail,
  dispatchSlack,
  dispatchGenericWebhook,
} from "../lib/alerts/dispatch";
import { runAlertJob } from "./alerts";

async function makeUserDestination(opts: {
  userAlertConfig?: unknown;
  destAlertConfig?: unknown;
}) {
  const user = await prisma.user.create({
    data: {
      email: `alert-${Date.now()}-${Math.random()}@test.local`,
      alertConfigJson: opts.userAlertConfig as never,
    },
  });
  const dest = await prisma.destination.create({
    data: {
      userId: user.id,
      name: "test-dest",
      url: "https://example.test/hook",
      alertConfigJson: opts.destAlertConfig as never,
    },
  });
  return { user, dest };
}

describe("runAlertJob", () => {
  const redis = getConnection();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await getAlertsQueue().close();
  });

  it("dispatches to all enabled channels once when cooldown is unclaimed", async () => {
    const slackEnc = encrypt("https://hooks.slack.com/services/T/B/abc");
    const webhookEnc = encrypt("https://example.com/hook");
    const { user, dest } = await makeUserDestination({
      userAlertConfig: {
        channels: {
          email: { enabled: true },
          slack: { enabled: true, webhookUrlEnc: slackEnc },
          webhook: { enabled: true, urlEnc: webhookEnc },
        },
        triggers: { exhausted: { enabled: true } },
        cooldownMinutes: 15,
      },
    });
    await redis.del(cooldownKey(dest.id, "exhausted"));

    await runAlertJob({
      destinationId: dest.id,
      trigger: "exhausted",
      deliveryId: "del_test",
      lastError: "HTTP 500",
    });

    expect(dispatchEmail).toHaveBeenCalledTimes(1);
    expect(dispatchEmail).toHaveBeenCalledWith(user.email, expect.objectContaining({
      destinationId: dest.id,
      trigger: "exhausted",
    }));
    expect(dispatchSlack).toHaveBeenCalledTimes(1);
    expect(dispatchGenericWebhook).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch when the cooldown is already claimed", async () => {
    const { dest } = await makeUserDestination({
      userAlertConfig: {
        channels: { email: { enabled: true } },
        triggers: { exhausted: { enabled: true } },
        cooldownMinutes: 15,
      },
    });
    await redis.set(cooldownKey(dest.id, "exhausted"), "1", "EX", 60);

    await runAlertJob({
      destinationId: dest.id,
      trigger: "exhausted",
      deliveryId: "del_test",
    });

    expect(dispatchEmail).not.toHaveBeenCalled();
  });

  it("continues dispatching other channels when one throws", async () => {
    vi.mocked(dispatchSlack).mockRejectedValueOnce(new Error("slack down"));
    const slackEnc = encrypt("https://hooks.slack.com/services/T/B/abc");
    const { dest } = await makeUserDestination({
      userAlertConfig: {
        channels: {
          email: { enabled: true },
          slack: { enabled: true, webhookUrlEnc: slackEnc },
        },
        triggers: { exhausted: { enabled: true } },
      },
    });
    await redis.del(cooldownKey(dest.id, "exhausted"));

    await expect(
      runAlertJob({
        destinationId: dest.id,
        trigger: "exhausted",
        deliveryId: "del_test",
      }),
    ).rejects.toThrow(/slack down/);

    // Email still went through despite the Slack failure.
    expect(dispatchEmail).toHaveBeenCalledTimes(1);
  });

  it("silently drops when the destination has been deleted", async () => {
    await expect(
      runAlertJob({
        destinationId: "nonexistent",
        trigger: "exhausted",
        deliveryId: "del_test",
      }),
    ).resolves.toBeUndefined();
    expect(dispatchEmail).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -- src/workers/alerts.test.ts`
Expected: FAIL — module `./alerts` does not exist.

- [ ] **Step 3: Implement `src/workers/alerts.ts`**

```ts
import "dotenv/config";
import * as Sentry from "@sentry/nextjs";
import { Worker, type Job } from "bullmq";

import { prisma } from "../lib/prisma";
import { getConnection } from "../lib/queue";
import { ALERTS_QUEUE, getAlertsQueue, type AlertJob } from "../lib/alerts/queue";
import { parseStoredConfig, mergeAlertConfigs } from "../lib/alerts/config";
import { tryClaimCooldown } from "../lib/alerts/cooldown";
import {
  dispatchEmail,
  dispatchSlack,
  dispatchGenericWebhook,
} from "../lib/alerts/dispatch";
import type { AlertContext } from "../lib/alerts/compose";

/**
 * Process one alert job. Exported separately so tests can call it directly
 * without booting a Worker.
 */
export async function runAlertJob(job: AlertJob): Promise<void> {
  const dest = await prisma.destination.findUnique({
    where: { id: job.destinationId },
    select: {
      id: true,
      name: true,
      alertConfigJson: true,
      user: { select: { email: true, alertConfigJson: true } },
    },
  });
  if (!dest) {
    // Deleted between enqueue and process — drop silently.
    return;
  }

  const userCfg = parseStoredConfig(dest.user.alertConfigJson);
  const destCfg = parseStoredConfig(dest.alertConfigJson);
  const cfg = mergeAlertConfigs(userCfg, destCfg);

  const cooldownSec = (cfg.cooldownMinutes ?? 15) * 60;
  const claimed = await tryClaimCooldown(job.destinationId, job.trigger, cooldownSec);
  if (!claimed) {
    return;
  }

  const ctx: AlertContext = {
    destinationId: dest.id,
    destinationName: dest.name,
    trigger: job.trigger,
    deliveryId: job.deliveryId,
    lastError: job.lastError,
    failureCount: job.failureCount,
    windowSize: job.windowSize,
    afterSuccesses: job.afterSuccesses,
  };

  const tasks: Array<Promise<void>> = [];
  if (cfg.channels?.email?.enabled) {
    tasks.push(dispatchEmail(dest.user.email, ctx));
  }
  if (cfg.channels?.slack?.enabled) {
    tasks.push(dispatchSlack(cfg.channels.slack.webhookUrlEnc, ctx));
  }
  if (cfg.channels?.webhook?.enabled) {
    tasks.push(
      dispatchGenericWebhook(
        cfg.channels.webhook.urlEnc,
        cfg.channels.webhook.headersEnc,
        ctx,
      ),
    );
  }
  if (tasks.length === 0) return;

  const results = await Promise.allSettled(tasks);
  const failures = results.filter(
    (r): r is PromiseRejectedResult => r.status === "rejected",
  );
  if (failures.length > 0) {
    // Throwing here triggers BullMQ retries (3 attempts, exp backoff).
    // Cooldown remains claimed, so the channels that already succeeded
    // won't double-fire from a separate trigger event, but ALL channels
    // re-run on the same job retry (accepted at-least-once duplication).
    throw new Error(
      `alert dispatch had ${failures.length} failure(s): ${failures
        .map((f) => String(f.reason))
        .join("; ")}`,
    );
  }
}

let _worker: Worker<AlertJob> | null = null;

export function startAlertWorker(): Worker<AlertJob> {
  if (_worker) return _worker;
  _worker = new Worker<AlertJob>(
    ALERTS_QUEUE,
    async (job: Job<AlertJob>) => {
      await runAlertJob(job.data);
    },
    {
      connection: getConnection(),
      concurrency: 4,
    },
  );
  _worker.on("ready", () => console.log("[alerts-worker] ready"));
  _worker.on("error", (err) => console.error("[alerts-worker] error:", err));
  _worker.on("failed", (job, err) => {
    console.error(`[alerts-worker] job ${job?.id} failed:`, err);
    if (job?.attemptsMade && job.attemptsMade >= 3) {
      Sentry.captureException(err, {
        tags: {
          destinationId: job.data.destinationId,
          trigger: job.data.trigger,
        },
      });
    }
  });
  return _worker;
}

export async function stopAlertWorker(): Promise<void> {
  if (_worker) {
    await _worker.close();
    _worker = null;
  }
  await getAlertsQueue().close();
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -- src/workers/alerts.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workers/alerts.ts src/workers/alerts.test.ts
git commit -m "feat(alerts): worker that dispatches enabled channels in parallel"
```

---

## Task 10: Boot alert worker from `delivery.ts`

**Files:**
- Modify: `src/workers/delivery.ts`

Add the alert worker boot near the existing delivery worker boot, and include it in the shutdown sequence.

- [ ] **Step 1: Modify `src/workers/delivery.ts`**

Add the import near the other worker-side imports (after the existing `composeDestinationDisabledEmail` import):

```ts
import { startAlertWorker, stopAlertWorker } from "./alerts";
```

Right after the existing `worker.on("failed", ...)` line and before the reaper block, add:

```ts
const alertWorker = startAlertWorker();
// startAlertWorker already attaches its own ready/error/failed listeners.
// Hold the reference so shutdown can close it cleanly.
void alertWorker;
```

In the existing `shutdown()` function, add an `await stopAlertWorker()` call just before `await worker.close()`:

```ts
async function shutdown() {
  console.log("[worker] shutting down...");
  clearInterval(reaperTimer);
  await stopAlertWorker();
  await worker.close();
  await getDeliveryQueue().close();
  await getConnection().quit();
  process.exit(0);
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 3: Smoke-test the worker boots without errors**

Run: `npm run worker` (foreground).
Expected: log lines include both `[worker] ready` and `[alerts-worker] ready`.
Stop with Ctrl-C; expected: shutdown log + clean exit.

- [ ] **Step 4: Commit**

```bash
git add src/workers/delivery.ts
git commit -m "feat(alerts): boot alert worker alongside delivery worker"
```

---

## Task 11: Enqueue entrypoint + wire into delivery completion

**Files:**
- Create: `src/lib/alerts/index.ts`
- Test: `src/lib/alerts/index.test.ts`
- Modify: `src/workers/delivery.ts`

`maybeEnqueueAlerts` is the seam between delivery and alerts. It:
1. Loads effective config for the destination's owner + destination override.
2. Loads recent delivery history for the rate/firstFailure triggers.
3. Calls the pure trigger functions.
4. Enqueues one `AlertJob` per firing trigger.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/alerts/index.test.ts`:

```ts
import "dotenv/config";

import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "../prisma";

vi.mock("./queue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./queue")>();
  const adds: unknown[] = [];
  return {
    ...actual,
    getAlertsQueue: () => ({
      add: vi.fn(async (name: string, data: unknown) => {
        adds.push({ name, data });
      }),
    }),
    __getAdds: () => adds,
    __resetAdds: () => {
      adds.length = 0;
    },
  };
});

import { maybeEnqueueAlerts } from "./index";
// @ts-expect-error — accessing test-only export via mock
import { __getAdds, __resetAdds } from "./queue";

async function makeFixture(opts: {
  userAlertConfig?: unknown;
  destAlertConfig?: unknown;
}) {
  const user = await prisma.user.create({
    data: {
      email: `idx-${Date.now()}-${Math.random()}@test.local`,
      alertConfigJson: opts.userAlertConfig as never,
    },
  });
  const source = await prisma.source.create({
    data: { userId: user.id, name: "src", slug: `src-${Date.now()}-${Math.random()}` },
  });
  const dest = await prisma.destination.create({
    data: {
      userId: user.id,
      name: "dst",
      url: "https://example.test/hook",
      alertConfigJson: opts.destAlertConfig as never,
    },
  });
  return { user, source, dest };
}

async function createDelivery(
  sourceId: string,
  destinationId: string,
  status: "delivered" | "failed" | "exhausted",
) {
  const event = await prisma.event.create({
    data: {
      sourceId,
      method: "POST",
      headersJson: {},
      bodyRaw: "{}",
    },
  });
  return prisma.delivery.create({
    data: { eventId: event.id, destinationId, status },
  });
}

describe("maybeEnqueueAlerts", () => {
  beforeEach(() => __resetAdds());

  it("enqueues an exhausted-trigger job when the outcome is exhausted and trigger is on", async () => {
    const { source, dest } = await makeFixture({
      userAlertConfig: {
        channels: { email: { enabled: true } },
        triggers: { exhausted: { enabled: true } },
      },
    });
    const delivery = await createDelivery(source.id, dest.id, "exhausted");

    await maybeEnqueueAlerts({
      destinationId: dest.id,
      deliveryId: delivery.id,
      outcomeStatus: "exhausted",
      lastError: "HTTP 500",
    });

    const adds = __getAdds() as Array<{ name: string; data: { trigger: string } }>;
    expect(adds).toHaveLength(1);
    expect(adds[0].name).toBe("exhausted");
    expect(adds[0].data.trigger).toBe("exhausted");
  });

  it("enqueues nothing when no triggers are enabled", async () => {
    const { source, dest } = await makeFixture({});
    const delivery = await createDelivery(source.id, dest.id, "exhausted");
    await maybeEnqueueAlerts({
      destinationId: dest.id,
      deliveryId: delivery.id,
      outcomeStatus: "exhausted",
    });
    expect(__getAdds()).toHaveLength(0);
  });

  it("enqueues a failureRate job when the recent window crosses the threshold", async () => {
    const { source, dest } = await makeFixture({
      userAlertConfig: {
        channels: { email: { enabled: true } },
        triggers: { failureRate: { enabled: true, ratePct: 50, windowCount: 4 } },
      },
    });
    // Build a history of 2 failures + 2 successes — 50% fail rate.
    await createDelivery(source.id, dest.id, "delivered");
    await createDelivery(source.id, dest.id, "delivered");
    await createDelivery(source.id, dest.id, "failed");
    const current = await createDelivery(source.id, dest.id, "exhausted");

    await maybeEnqueueAlerts({
      destinationId: dest.id,
      deliveryId: current.id,
      outcomeStatus: "exhausted",
    });
    const adds = __getAdds() as Array<{ name: string }>;
    expect(adds.map((a) => a.name)).toContain("failureRate");
  });

  it("does not double-fire firstFailure when only 2 prior successes exist (need 3)", async () => {
    const { source, dest } = await makeFixture({
      userAlertConfig: {
        channels: { email: { enabled: true } },
        triggers: { firstFailure: { enabled: true, afterSuccessCount: 3 } },
      },
    });
    await createDelivery(source.id, dest.id, "delivered");
    await createDelivery(source.id, dest.id, "delivered");
    const current = await createDelivery(source.id, dest.id, "exhausted");

    await maybeEnqueueAlerts({
      destinationId: dest.id,
      deliveryId: current.id,
      outcomeStatus: "exhausted",
    });
    expect(__getAdds()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -- src/lib/alerts/index.test.ts`
Expected: FAIL — module `./index` does not exist.

- [ ] **Step 3: Implement `src/lib/alerts/index.ts`**

```ts
import { prisma } from "../prisma";
import { parseStoredConfig, mergeAlertConfigs } from "./config";
import {
  shouldFireExhausted,
  shouldFireFailureRate,
  shouldFireFirstFailure,
  type DeliveryHistoryRow,
  type DeliveryStatus,
} from "./triggers";
import { getAlertsQueue, type AlertJob } from "./queue";
import type { AlertTrigger } from "./schema";

export type DeliveryOutcomeInput = {
  destinationId: string;
  deliveryId: string;
  outcomeStatus: DeliveryStatus;
  lastError?: string;
};

/**
 * Called by the delivery worker after every delivery completion (success
 * AND failure). Decides which triggers (if any) fire and enqueues one
 * AlertJob per firing trigger.
 *
 * History reads are kept minimal: we only load the recent window when at
 * least one trigger that needs it is enabled.
 */
export async function maybeEnqueueAlerts(input: DeliveryOutcomeInput): Promise<void> {
  const dest = await prisma.destination.findUnique({
    where: { id: input.destinationId },
    select: {
      id: true,
      alertConfigJson: true,
      user: { select: { alertConfigJson: true } },
    },
  });
  if (!dest) return;

  const userCfg = parseStoredConfig(dest.user.alertConfigJson);
  const destCfg = parseStoredConfig(dest.alertConfigJson);
  const cfg = mergeAlertConfigs(userCfg, destCfg);
  const triggers = cfg.triggers ?? {};

  // If nothing is on, skip the history read entirely.
  const needsHistory =
    !!triggers.failureRate?.enabled || !!triggers.firstFailure?.enabled;

  let history: DeliveryHistoryRow[] = [];
  if (needsHistory) {
    const windowSize = Math.max(
      triggers.failureRate?.windowCount ?? 0,
      // firstFailure looks at prior N, so we need afterSuccessCount + 1 (the current)
      (triggers.firstFailure?.afterSuccessCount ?? 0) + 1,
    );
    if (windowSize > 0) {
      const rows = await prisma.delivery.findMany({
        where: { destinationId: input.destinationId },
        select: { id: true, status: true },
        orderBy: { createdAt: "desc" },
        take: windowSize,
      });
      history = rows.map((r) => ({
        id: r.id,
        status: r.status as DeliveryStatus,
      }));
    }
  }

  // For firstFailure we want the priors *excluding* the current delivery.
  const priorHistory = history.filter((r) => r.id !== input.deliveryId);

  const firedTriggers: AlertTrigger[] = [];

  if (
    shouldFireExhausted(triggers.exhausted, { status: input.outcomeStatus })
  ) {
    firedTriggers.push("exhausted");
  }
  if (shouldFireFailureRate(triggers.failureRate, history)) {
    firedTriggers.push("failureRate");
  }
  if (
    shouldFireFirstFailure(
      triggers.firstFailure,
      { status: input.outcomeStatus },
      priorHistory,
    )
  ) {
    firedTriggers.push("firstFailure");
  }

  if (firedTriggers.length === 0) return;

  const queue = getAlertsQueue();
  await Promise.all(
    firedTriggers.map((trigger) => {
      const data: AlertJob = {
        destinationId: input.destinationId,
        trigger,
        deliveryId: input.deliveryId,
        lastError: input.lastError,
        ...(trigger === "failureRate"
          ? {
              failureCount: history
                .slice(0, triggers.failureRate!.windowCount)
                .filter((r) => r.status === "failed" || r.status === "exhausted").length,
              windowSize: triggers.failureRate!.windowCount,
            }
          : {}),
        ...(trigger === "firstFailure"
          ? { afterSuccesses: triggers.firstFailure!.afterSuccessCount }
          : {}),
      };
      return queue.add(trigger, data);
    }),
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -- src/lib/alerts/index.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire `maybeEnqueueAlerts` into `src/workers/delivery.ts`**

Add the import:

```ts
import { maybeEnqueueAlerts } from "../lib/alerts";
```

In `processDelivery`, the **success branch** currently ends with `recordSuccess(...)` then `return;`. Add a `maybeEnqueueAlerts` call before the return:

Find:
```ts
    try {
      await recordSuccess(delivery.destinationId);
    } catch (err) {
      console.error(
        `[worker] failed to reset breaker counter for ${delivery.destinationId}:`,
        err,
      );
    }
    return;
```

Replace with:
```ts
    try {
      await recordSuccess(delivery.destinationId);
    } catch (err) {
      console.error(
        `[worker] failed to reset breaker counter for ${delivery.destinationId}:`,
        err,
      );
    }
    try {
      await maybeEnqueueAlerts({
        destinationId: delivery.destinationId,
        deliveryId: deliveryId,
        outcomeStatus: "delivered",
      });
    } catch (err) {
      console.error(
        `[worker] failed to evaluate alerts for ${delivery.destinationId}:`,
        err,
      );
    }
    return;
```

In the **exhaust branch**, find:
```ts
    } catch (err) {
      console.error(
        `[worker] circuit-breaker bookkeeping failed for ${delivery.destinationId}:`,
        err,
      );
    }
    return;
  }
```

Replace with:
```ts
    } catch (err) {
      console.error(
        `[worker] circuit-breaker bookkeeping failed for ${delivery.destinationId}:`,
        err,
      );
    }
    try {
      await maybeEnqueueAlerts({
        destinationId: delivery.destinationId,
        deliveryId: deliveryId,
        outcomeStatus: "exhausted",
        lastError: errorMsg ?? undefined,
      });
    } catch (err) {
      console.error(
        `[worker] failed to evaluate alerts for ${delivery.destinationId}:`,
        err,
      );
    }
    return;
  }
```

In the **retry-scheduled branch** (failure that still has retries left), find the block that ends with the `console.warn` of "retry ... in" and add `maybeEnqueueAlerts` for the `failed` status. Find:

```ts
  console.warn(
    `[worker] retry ${deliveryId} in ${Math.round(delayMs / 1000)}s (attempt ${attempt}/${MAX_ATTEMPTS}): ${errorMsg}`,
  );
}
```

Replace with:
```ts
  console.warn(
    `[worker] retry ${deliveryId} in ${Math.round(delayMs / 1000)}s (attempt ${attempt}/${MAX_ATTEMPTS}): ${errorMsg}`,
  );
  try {
    await maybeEnqueueAlerts({
      destinationId: delivery.destinationId,
      deliveryId: deliveryId,
      outcomeStatus: "failed",
      lastError: errorMsg ?? undefined,
    });
  } catch (err) {
    console.error(
      `[worker] failed to evaluate alerts for ${delivery.destinationId}:`,
      err,
    );
  }
}
```

- [ ] **Step 6: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 7: Re-run the full test suite**

Run: `npm run test`
Expected: PASS (no regressions in existing tests).

- [ ] **Step 8: Commit**

```bash
git add src/lib/alerts/index.ts src/lib/alerts/index.test.ts src/workers/delivery.ts
git commit -m "feat(alerts): enqueue from delivery worker on every completion"
```

---

## Task 12: Server actions — save user defaults and destination override

**Files:**
- Create: `src/lib/actions/alerts.ts`

Mirror the `destinations.ts` action pattern: `requireUserId()` → Zod-parse FormData → validate plaintext URLs → encrypt → write JSON column → `revalidatePath`.

- [ ] **Step 1: Implement `src/lib/actions/alerts.ts`**

```ts
"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { encrypt, encryptJson } from "@/lib/crypto";
import {
  AlertConfigSchema,
  validateSlackWebhookUrl,
  validateGenericWebhookUrl,
  type AlertConfig,
} from "@/lib/alerts/schema";

async function requireUserId(): Promise<string> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("unauthorized");
  return session.user.id;
}

// FormData shape — strings only. The page sends each field as a separate
// FormData entry; we assemble the AlertConfig here. Unchecked checkbox =
// no entry in FormData, which we read as `false`.
function parseFormToConfig(form: FormData, appUrl: string): AlertConfig {
  const cfg: AlertConfig = { channels: {}, triggers: {}, cooldownMinutes: 15 };

  // Email channel
  const emailOn = form.get("channel.email.enabled") === "on";
  if (emailOn) {
    cfg.channels!.email = { enabled: true };
  }

  // Slack channel
  const slackOn = form.get("channel.slack.enabled") === "on";
  const slackUrl = String(form.get("channel.slack.url") ?? "").trim();
  if (slackOn || slackUrl) {
    if (!slackUrl) {
      throw new Error("Slack channel enabled but webhook URL is empty");
    }
    validateSlackWebhookUrl(slackUrl);
    cfg.channels!.slack = {
      enabled: slackOn,
      webhookUrlEnc: encrypt(slackUrl),
    };
  }

  // Generic webhook channel
  const webhookOn = form.get("channel.webhook.enabled") === "on";
  const webhookUrl = String(form.get("channel.webhook.url") ?? "").trim();
  const webhookHeaders = String(form.get("channel.webhook.headers") ?? "").trim();
  if (webhookOn || webhookUrl) {
    if (!webhookUrl) {
      throw new Error("Webhook channel enabled but URL is empty");
    }
    validateGenericWebhookUrl(webhookUrl, appUrl);
    let headersEnc: string | undefined;
    if (webhookHeaders) {
      let parsed: Record<string, string>;
      try {
        parsed = JSON.parse(webhookHeaders) as Record<string, string>;
      } catch {
        throw new Error("Webhook headers must be a JSON object of strings");
      }
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        throw new Error("Webhook headers must be a JSON object");
      }
      if (Object.keys(parsed).length > 10) {
        throw new Error("Webhook headers: at most 10 entries");
      }
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v !== "string") {
          throw new Error(`Webhook header ${k} must be a string`);
        }
      }
      headersEnc = encryptJson(parsed);
    }
    cfg.channels!.webhook = {
      enabled: webhookOn,
      urlEnc: encrypt(webhookUrl),
      ...(headersEnc ? { headersEnc } : {}),
    };
  }

  // Triggers
  if (form.get("trigger.exhausted.enabled") === "on") {
    cfg.triggers!.exhausted = { enabled: true };
  }
  if (form.get("trigger.failureRate.enabled") === "on") {
    cfg.triggers!.failureRate = {
      enabled: true,
      ratePct: z.coerce
        .number()
        .int()
        .min(1)
        .max(100)
        .parse(form.get("trigger.failureRate.ratePct") ?? 50),
      windowCount: z.coerce
        .number()
        .int()
        .min(2)
        .max(200)
        .parse(form.get("trigger.failureRate.windowCount") ?? 20),
    };
  }
  if (form.get("trigger.firstFailure.enabled") === "on") {
    cfg.triggers!.firstFailure = {
      enabled: true,
      afterSuccessCount: z.coerce
        .number()
        .int()
        .min(1)
        .max(50)
        .parse(form.get("trigger.firstFailure.afterSuccessCount") ?? 5),
    };
  }

  const cooldown = form.get("cooldownMinutes");
  if (cooldown != null && String(cooldown).length > 0) {
    cfg.cooldownMinutes = z.coerce.number().int().min(1).max(1440).parse(cooldown);
  }

  // Final defense — bounce anything that survives the field-by-field parse
  // but doesn't match the canonical schema.
  return AlertConfigSchema.parse(cfg);
}

export async function saveUserAlerts(formData: FormData): Promise<void> {
  const userId = await requireUserId();
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
  const cfg = parseFormToConfig(formData, appUrl);
  await prisma.user.update({
    where: { id: userId },
    data: { alertConfigJson: cfg as never },
  });
  revalidatePath("/settings/alerts");
}

export async function saveDestinationAlerts(formData: FormData): Promise<void> {
  const userId = await requireUserId();
  const destinationId = String(formData.get("destinationId") ?? "");
  if (!destinationId) throw new Error("destinationId is required");
  const dest = await prisma.destination.findFirst({
    where: { id: destinationId, userId },
    select: { id: true },
  });
  if (!dest) throw new Error("not found");
  const useDefaults = formData.get("useDefaults") === "on";
  if (useDefaults) {
    await prisma.destination.update({
      where: { id: destinationId },
      data: { alertConfigJson: null as never },
    });
  } else {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
    const cfg = parseFormToConfig(formData, appUrl);
    await prisma.destination.update({
      where: { id: destinationId },
      data: { alertConfigJson: cfg as never },
    });
  }
  revalidatePath(`/destinations/${destinationId}`);
  revalidatePath("/destinations");
}

const TEST_CHANNELS = ["email", "slack", "webhook"] as const;
type TestChannel = (typeof TEST_CHANNELS)[number];

export async function sendTestAlert(formData: FormData): Promise<void> {
  const userId = await requireUserId();
  const channel = String(formData.get("channel") ?? "") as TestChannel;
  if (!TEST_CHANNELS.includes(channel)) {
    throw new Error(`unknown test channel: ${channel}`);
  }
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { email: true, alertConfigJson: true },
  });
  // Lazy-load dispatch so the server-action surface doesn't pull worker
  // deps when only rendering the page.
  const { parseStoredConfig } = await import("@/lib/alerts/config");
  const { dispatchEmail, dispatchSlack, dispatchGenericWebhook } = await import(
    "@/lib/alerts/dispatch"
  );
  const cfg = parseStoredConfig(user.alertConfigJson);
  const ctx = {
    destinationId: "test",
    destinationName: "Test destination",
    trigger: "exhausted" as const,
    deliveryId: "test",
    lastError: "Test alert from /settings/alerts",
  };
  if (channel === "email" && cfg?.channels?.email?.enabled) {
    await dispatchEmail(user.email, ctx);
    return;
  }
  if (channel === "slack" && cfg?.channels?.slack?.enabled) {
    await dispatchSlack(cfg.channels.slack.webhookUrlEnc, ctx);
    return;
  }
  if (channel === "webhook" && cfg?.channels?.webhook?.enabled) {
    await dispatchGenericWebhook(
      cfg.channels.webhook.urlEnc,
      cfg.channels.webhook.headersEnc,
      ctx,
    );
    return;
  }
  throw new Error(`channel ${channel} is not enabled in your alert config`);
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/actions/alerts.ts
git commit -m "feat(alerts): server actions for user/destination config + sendTest"
```

---

## Task 13: `/settings/alerts` page

**Files:**
- Create: `src/app/(dashboard)/settings/alerts/page.tsx`

Server component that loads the current `User.alertConfigJson`, renders the form, and wires it to `saveUserAlerts`. Mirrors the visual pattern of `src/app/(dashboard)/settings/api-keys/page.tsx`.

- [ ] **Step 1: Implement `src/app/(dashboard)/settings/alerts/page.tsx`**

```tsx
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { parseStoredConfig } from "@/lib/alerts/config";
import { saveUserAlerts, sendTestAlert } from "@/lib/actions/alerts";
import { DEFAULT_ALERT_CONFIG } from "@/lib/alerts/schema";

export const dynamic = "force-dynamic";

export default async function AlertsSettingsPage() {
  const session = await auth();
  if (!session?.user?.id) return null;

  const user = await prisma.user.findUniqueOrThrow({
    where: { id: session.user.id },
    select: { email: true, alertConfigJson: true },
  });
  const cfg = parseStoredConfig(user.alertConfigJson) ?? DEFAULT_ALERT_CONFIG;

  return (
    <div className="max-w-3xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Alerts</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Configure how Odyhook notifies you when a destination is unhealthy.
          These are account-wide defaults; any destination can override them
          on its own page.
        </p>
      </div>

      <form action={saveUserAlerts} className="space-y-6">
        {/* Email */}
        <section className="rounded-lg border border-zinc-200 bg-white p-4 sm:p-6 dark:border-zinc-700 dark:bg-zinc-900">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-sm font-medium">Email</h2>
              <p className="mt-1 text-xs text-zinc-500">
                Sent to <span className="font-mono">{user.email}</span>.
              </p>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="channel.email.enabled"
                defaultChecked={!!cfg.channels?.email?.enabled}
              />
              Enabled
            </label>
          </div>
        </section>

        {/* Slack */}
        <section className="rounded-lg border border-zinc-200 bg-white p-4 sm:p-6 dark:border-zinc-700 dark:bg-zinc-900">
          <div className="flex items-start justify-between gap-4">
            <h2 className="text-sm font-medium">Slack incoming webhook</h2>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="channel.slack.enabled"
                defaultChecked={!!cfg.channels?.slack?.enabled}
              />
              Enabled
            </label>
          </div>
          <label className="mt-3 flex flex-col gap-1 text-sm">
            <span className="text-zinc-600 dark:text-zinc-400">Webhook URL</span>
            <input
              name="channel.slack.url"
              type="url"
              placeholder="https://hooks.slack.com/services/T000/B000/abcdef"
              className="h-9 rounded-md border border-zinc-200 bg-white px-3 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
          <p className="mt-2 text-xs text-zinc-500">
            URL is stored encrypted and never shown again. Re-enter it to update.
          </p>
        </section>

        {/* Generic webhook */}
        <section className="rounded-lg border border-zinc-200 bg-white p-4 sm:p-6 dark:border-zinc-700 dark:bg-zinc-900">
          <div className="flex items-start justify-between gap-4">
            <h2 className="text-sm font-medium">Generic webhook</h2>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="channel.webhook.enabled"
                defaultChecked={!!cfg.channels?.webhook?.enabled}
              />
              Enabled
            </label>
          </div>
          <label className="mt-3 flex flex-col gap-1 text-sm">
            <span className="text-zinc-600 dark:text-zinc-400">URL (https only)</span>
            <input
              name="channel.webhook.url"
              type="url"
              placeholder="https://hooks.example.com/odyhook"
              className="h-9 rounded-md border border-zinc-200 bg-white px-3 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
          <label className="mt-3 flex flex-col gap-1 text-sm">
            <span className="text-zinc-600 dark:text-zinc-400">
              Headers (JSON object, optional)
            </span>
            <textarea
              name="channel.webhook.headers"
              rows={3}
              placeholder={`{"X-Api-Key": "..."}`}
              className="rounded-md border border-zinc-200 bg-white px-3 py-2 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
        </section>

        {/* Triggers */}
        <section className="rounded-lg border border-zinc-200 bg-white p-4 sm:p-6 dark:border-zinc-700 dark:bg-zinc-900">
          <h2 className="text-sm font-medium">Triggers</h2>

          <label className="mt-4 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="trigger.exhausted.enabled"
              defaultChecked={!!cfg.triggers?.exhausted?.enabled}
            />
            <span>
              <strong>Exhausted delivery</strong> — fire when a delivery uses up all
              retries.
            </span>
          </label>

          <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                name="trigger.failureRate.enabled"
                defaultChecked={!!cfg.triggers?.failureRate?.enabled}
              />
              <strong>High failure rate</strong> — fire when
            </label>
            <input
              name="trigger.failureRate.ratePct"
              type="number"
              min={1}
              max={100}
              defaultValue={cfg.triggers?.failureRate?.ratePct ?? 50}
              className="h-8 w-20 rounded-md border border-zinc-200 bg-white px-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
            <span>% of the last</span>
            <input
              name="trigger.failureRate.windowCount"
              type="number"
              min={2}
              max={200}
              defaultValue={cfg.triggers?.failureRate?.windowCount ?? 20}
              className="h-8 w-24 rounded-md border border-zinc-200 bg-white px-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
            <span>deliveries failed.</span>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                name="trigger.firstFailure.enabled"
                defaultChecked={!!cfg.triggers?.firstFailure?.enabled}
              />
              <strong>First failure after recovery</strong> — fire on the next
              failure after
            </label>
            <input
              name="trigger.firstFailure.afterSuccessCount"
              type="number"
              min={1}
              max={50}
              defaultValue={cfg.triggers?.firstFailure?.afterSuccessCount ?? 5}
              className="h-8 w-20 rounded-md border border-zinc-200 bg-white px-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
            <span>consecutive successes.</span>
          </div>
        </section>

        {/* Cooldown */}
        <section className="rounded-lg border border-zinc-200 bg-white p-4 sm:p-6 dark:border-zinc-700 dark:bg-zinc-900">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-zinc-600 dark:text-zinc-400">
              Cooldown (minutes between alerts of the same kind on the same destination)
            </span>
            <input
              name="cooldownMinutes"
              type="number"
              min={1}
              max={1440}
              defaultValue={cfg.cooldownMinutes ?? 15}
              className="h-9 w-32 rounded-md border border-zinc-200 bg-white px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
        </section>

        <button
          type="submit"
          className="h-9 rounded-md bg-zinc-900 px-4 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
        >
          Save alert settings
        </button>
      </form>

      {/* Test buttons live in a separate form so submitting one doesn't
          carry every other field's value. */}
      <section className="rounded-lg border border-dashed border-zinc-200 bg-white p-4 dark:border-zinc-700 dark:bg-zinc-900">
        <h2 className="text-sm font-medium">Send test alert</h2>
        <p className="mt-1 text-xs text-zinc-500">
          Fires a sample alert through the channel — bypasses cooldown.
          Save your config first.
        </p>
        <div className="mt-3 flex gap-2">
          {(["email", "slack", "webhook"] as const).map((ch) => (
            <form key={ch} action={sendTestAlert}>
              <input type="hidden" name="channel" value={ch} />
              <button
                type="submit"
                className="h-8 rounded-md border border-zinc-300 bg-white px-3 text-xs hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800"
              >
                Test {ch}
              </button>
            </form>
          ))}
        </div>
      </section>
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 3: Smoke-test the page renders**

Run: `npm run dev` (in one terminal). Open `http://localhost:3000/settings/alerts` (sign in via MailHog at `localhost:8025` first if needed). Confirm the page loads with all sections.

- [ ] **Step 4: Commit**

```bash
git add 'src/app/(dashboard)/settings/alerts/page.tsx'
git commit -m "feat(alerts): /settings/alerts page for account-wide defaults"
```

---

## Task 14: Per-destination override page

**Files:**
- Create: `src/app/(dashboard)/destinations/[id]/page.tsx`
- Modify: `src/app/(dashboard)/destinations/page.tsx` (add a link per row)

The destination detail page hosts the alert override section. Build it as a thin page that delegates to the same UI fragments — but for v1 we duplicate the form markup with `useDefaults` / `customize` radio. (Refactoring into a shared component is an after-the-fact improvement once both pages are stable.)

- [ ] **Step 1: Implement `src/app/(dashboard)/destinations/[id]/page.tsx`**

```tsx
import { notFound } from "next/navigation";
import Link from "next/link";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { parseStoredConfig, mergeAlertConfigs } from "@/lib/alerts/config";
import { saveDestinationAlerts } from "@/lib/actions/alerts";

export const dynamic = "force-dynamic";

export default async function DestinationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user?.id) return null;

  const dest = await prisma.destination.findFirst({
    where: { id, userId: session.user.id },
    select: {
      id: true,
      name: true,
      url: true,
      enabled: true,
      alertConfigJson: true,
      user: { select: { email: true, alertConfigJson: true } },
    },
  });
  if (!dest) notFound();

  const userCfg = parseStoredConfig(dest.user.alertConfigJson);
  const destCfg = parseStoredConfig(dest.alertConfigJson);
  const usingDefaults = destCfg === null;
  const effective = mergeAlertConfigs(userCfg, destCfg);

  return (
    <div className="max-w-3xl space-y-8">
      <div>
        <Link
          href="/destinations"
          className="text-sm text-zinc-500 hover:underline"
        >
          ← Destinations
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{dest.name}</h1>
        <p className="mt-1 font-mono text-xs text-zinc-500">{dest.url}</p>
      </div>

      <form action={saveDestinationAlerts} className="space-y-6">
        <input type="hidden" name="destinationId" value={dest.id} />

        <section className="rounded-lg border border-zinc-200 bg-white p-4 sm:p-6 dark:border-zinc-700 dark:bg-zinc-900">
          <h2 className="text-sm font-medium">Alerts</h2>
          <div className="mt-3 space-y-2 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                name="useDefaults"
                defaultChecked={usingDefaults}
              />
              <span>Use account defaults (configured at <Link href="/settings/alerts" className="underline">Settings → Alerts</Link>)</span>
            </label>
            <p className="text-xs text-zinc-500">
              When checked, this destination inherits your account-wide alert
              settings. Uncheck to override below.
            </p>
          </div>
        </section>

        {/* Same form fields as /settings/alerts, prefilled with the
            destination's own override (or the resolved effective config if
            no override exists yet). */}
        <section className="rounded-lg border border-zinc-200 bg-white p-4 sm:p-6 dark:border-zinc-700 dark:bg-zinc-900">
          <h2 className="text-sm font-medium">Channels for this destination</h2>

          <div className="mt-3 space-y-3">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="channel.email.enabled"
                defaultChecked={!!effective.channels?.email?.enabled}
              />
              Email → <span className="font-mono text-xs">{dest.user.email}</span>
            </label>

            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="channel.slack.enabled"
                  defaultChecked={!!effective.channels?.slack?.enabled}
                />
                Slack webhook URL
              </label>
              <input
                name="channel.slack.url"
                type="url"
                placeholder="https://hooks.slack.com/services/..."
                className="h-9 w-full rounded-md border border-zinc-200 bg-white px-3 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-900"
              />
            </div>

            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="channel.webhook.enabled"
                  defaultChecked={!!effective.channels?.webhook?.enabled}
                />
                Generic webhook URL
              </label>
              <input
                name="channel.webhook.url"
                type="url"
                placeholder="https://hooks.example.com/odyhook"
                className="h-9 w-full rounded-md border border-zinc-200 bg-white px-3 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-900"
              />
              <textarea
                name="channel.webhook.headers"
                rows={3}
                placeholder={`{"X-Api-Key": "..."}`}
                className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-900"
              />
            </div>
          </div>
        </section>

        <section className="rounded-lg border border-zinc-200 bg-white p-4 sm:p-6 dark:border-zinc-700 dark:bg-zinc-900">
          <h2 className="text-sm font-medium">Triggers</h2>

          <label className="mt-3 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="trigger.exhausted.enabled"
              defaultChecked={!!effective.triggers?.exhausted?.enabled}
            />
            Exhausted delivery
          </label>

          <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                name="trigger.failureRate.enabled"
                defaultChecked={!!effective.triggers?.failureRate?.enabled}
              />
              Failure rate
            </label>
            <input
              name="trigger.failureRate.ratePct"
              type="number"
              min={1}
              max={100}
              defaultValue={effective.triggers?.failureRate?.ratePct ?? 50}
              className="h-8 w-20 rounded-md border border-zinc-200 bg-white px-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
            <span>% over last</span>
            <input
              name="trigger.failureRate.windowCount"
              type="number"
              min={2}
              max={200}
              defaultValue={effective.triggers?.failureRate?.windowCount ?? 20}
              className="h-8 w-24 rounded-md border border-zinc-200 bg-white px-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
            <span>deliveries</span>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                name="trigger.firstFailure.enabled"
                defaultChecked={!!effective.triggers?.firstFailure?.enabled}
              />
              First failure after
            </label>
            <input
              name="trigger.firstFailure.afterSuccessCount"
              type="number"
              min={1}
              max={50}
              defaultValue={effective.triggers?.firstFailure?.afterSuccessCount ?? 5}
              className="h-8 w-20 rounded-md border border-zinc-200 bg-white px-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
            <span>successes</span>
          </div>
        </section>

        <section className="rounded-lg border border-zinc-200 bg-white p-4 sm:p-6 dark:border-zinc-700 dark:bg-zinc-900">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-zinc-600 dark:text-zinc-400">
              Cooldown minutes (override)
            </span>
            <input
              name="cooldownMinutes"
              type="number"
              min={1}
              max={1440}
              defaultValue={effective.cooldownMinutes ?? 15}
              className="h-9 w-32 rounded-md border border-zinc-200 bg-white px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
        </section>

        <button
          type="submit"
          className="h-9 rounded-md bg-zinc-900 px-4 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
        >
          Save destination alerts
        </button>
      </form>
    </div>
  );
}
```

- [ ] **Step 2: Add an "Edit alerts" link to each row of `src/app/(dashboard)/destinations/page.tsx`**

Add the `Link` import at the top of the file, just after the existing imports:

```ts
import Link from "next/link";
```

Then find the per-row action cluster:

```tsx
<td className="px-4 py-3 text-right">
  <div className="inline-flex items-center gap-3">
    <form action={toggleDestinationEnabled}>
```

Replace it with the same block plus a leading link:

```tsx
<td className="px-4 py-3 text-right">
  <div className="inline-flex items-center gap-3">
    <Link
      href={`/destinations/${d.id}`}
      className="text-xs text-zinc-600 hover:underline dark:text-zinc-300"
    >
      Edit alerts
    </Link>
    <form action={toggleDestinationEnabled}>
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 4: Smoke-test the page**

With `npm run dev` running, visit `/destinations`, click "Edit alerts →" on any destination, confirm the page renders and the "Use account defaults" checkbox reflects the destination's actual state.

- [ ] **Step 5: Commit**

```bash
git add 'src/app/(dashboard)/destinations/[id]/page.tsx' 'src/app/(dashboard)/destinations/page.tsx'
git commit -m "feat(alerts): per-destination alert override page + list link"
```

---

## Task 15: Nav link to `/settings/alerts`

**Files:**
- Modify: `src/components/nav-links.tsx`

The top nav is driven by a `NAV` array in `src/components/nav-links.tsx`. Add an "Alerts" entry right after the existing "Settings" entry.

- [ ] **Step 1: Modify `src/components/nav-links.tsx`**

Find:

```ts
const NAV = [
  { href: "/sources", label: "Sources" },
  { href: "/events", label: "Events" },
  { href: "/destinations", label: "Destinations" },
  { href: "/routes", label: "Routes" },
  { href: "/settings/api-keys", label: "Settings" },
];
```

Replace with:

```ts
const NAV = [
  { href: "/sources", label: "Sources" },
  { href: "/events", label: "Events" },
  { href: "/destinations", label: "Destinations" },
  { href: "/routes", label: "Routes" },
  { href: "/settings/api-keys", label: "Settings" },
  { href: "/settings/alerts", label: "Alerts" },
];
```

- [ ] **Step 2: Verify the link is visible**

With `npm run dev` running, sign in, confirm "Alerts" appears in the top nav (and on mobile, in the horizontal sub-nav) and routes correctly to `/settings/alerts`.

- [ ] **Step 3: Commit**

```bash
git add src/components/nav-links.tsx
git commit -m "feat(alerts): nav link to /settings/alerts"
```

---

## Task 16: End-to-end smoke test (manual)

**Files:**
- None (manual verification documented for future reference)

- [ ] **Step 1: Start the stack**

```bash
docker compose up -d postgres redis mailhog
npm run db:migrate    # if not already applied
npm run dev           # terminal 1
npm run worker        # terminal 2
```

- [ ] **Step 2: Sign in and configure alerts**

1. Open `http://localhost:3000`, sign in via the MailHog inbox at `http://localhost:8025`.
2. Go to `/settings/alerts`.
3. Enable Email channel, enable the **Exhausted delivery** trigger, set cooldown = 1 minute.
4. Save.

- [ ] **Step 3: Create a deliberately broken destination**

1. Go to `/destinations`.
2. Create a new destination pointing at `http://127.0.0.1:9` (always refused — note the SSRF guard may reject `127.0.0.1`; if so, use `https://httpstat.us/500` instead so the URL passes validation and the response is always 5xx).
3. Create a Source (if you don't have one) and a Route from that Source to the broken Destination.

- [ ] **Step 4: Force an exhausted delivery**

For convenience, set `RETRY_DELAYS_MS` short — or just `curl` 1 event and let the worker exhaust it naturally over the full retry schedule (~8h, not practical). For the smoke test, temporarily lower the retry schedule in `src/lib/queue.ts` to `[100, 100, 100, 100, 100, 100]`, restart the worker, then:

```bash
curl -X POST -H "content-type: application/json" \
  -d '{"hello":"world"}' \
  http://localhost:3000/api/ingest/<your-source-slug>
```

Watch the worker logs for `[worker] exhausted ...` and `[alerts-worker] ready` activity.

- [ ] **Step 5: Confirm the alert email lands in MailHog**

Refresh `http://localhost:8025`. Expected: a new email with subject like `Odyhook: exhausted (all retries used) on "..."`.

- [ ] **Step 6: Confirm cooldown**

Trigger another exhausted delivery within the 1-minute cooldown window. Expected: **no** new email in MailHog (cooldown suppressed it). Wait > 1 minute, repeat — expected: a new email arrives.

- [ ] **Step 7: Restore retry schedule and clean up**

Revert the temporary edit to `src/lib/queue.ts` (or commit a no-op revert), delete the test destination/source. Document any quirks in a PR description.

- [ ] **Step 8: Commit no-op revert if needed and final cleanup commit**

If the retry-delay edit was committed, revert it; otherwise no commit needed.

```bash
git status  # should be clean
```

---

## Final verification

- [ ] **Step 1: Full test suite passes**

Run: `npm run test`
Expected: every test green, no regressions in existing files.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: zero errors.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: successful Next.js production build.

- [ ] **Step 5: Final commit if any auto-fixes ran**

```bash
git status
# If lint or build produced any changes, commit them:
# git commit -am "chore(alerts): lint/build fixes"
```
