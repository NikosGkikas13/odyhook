# AI-Explained Event Diffs (#11) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user pick two events and get Claude's plain-English explanation of what changed between their payloads, on a dedicated `/events/compare` page, cached per event-pair.

**Architecture:** Reuses the codebase's established AI-feature pattern: pure logic in `src/lib/ai/event-diff.ts`, a server action that caches the result on a new `AiEventDiff` row, and a small client button gated on `hasApiKey`. Entry point is a "Compare with AI" button in the existing events bulk-actions bar (enabled only when exactly 2 selected). Direction is canonicalized older→newer by `receivedAt` so the diff reads chronologically and the cache key is order-independent.

**Tech Stack:** Next.js 16 (App Router, server actions), Prisma 7, Anthropic SDK (BYOK via `anthropicFor`), Vitest 4, Tailwind 4.

**Design spec:** `docs/superpowers/specs/2026-06-01-ai-event-diffs-design.md`

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `prisma/schema.prisma` | Add `AiEventDiff` model + `Event` back-relations | Modify |
| `src/lib/ai/event-diff.ts` | Pure logic: `explainEventDiff()` (Anthropic call + JSON parse), `canonicalPair()` (older→newer ordering), types, `EventDiffError` | Create |
| `src/lib/ai/event-diff.test.ts` | Vitest unit tests for the pure logic | Create |
| `src/lib/actions/event-diff.ts` | Server action: auth, ownership guard, cache read/write, calls `explainEventDiff` | Create |
| `src/components/explain-diff-button.tsx` | Client button: triggers action, renders summary + changes | Create |
| `src/app/(dashboard)/events/compare/page.tsx` | Server page: loads both events, renders payloads + button | Create |
| `src/components/events-bulk-actions.tsx` | Add "Compare with AI" button | Modify |

---

## Task 1: AiEventDiff Prisma model + migration

**Files:**
- Modify: `prisma/schema.prisma` (Event model ~line 238, and append new model)

- [ ] **Step 1: Add back-relations to the Event model**

In `prisma/schema.prisma`, inside `model Event`, after the existing `deliveries Delivery[]` line (around line 239), add:

```prisma
  deliveries Delivery[]
  diffsAsA   AiEventDiff[] @relation("DiffEventA")
  diffsAsB   AiEventDiff[] @relation("DiffEventB")
```

- [ ] **Step 2: Append the AiEventDiff model**

Add this new model to `prisma/schema.prisma` (place it near the other AI model `AiDiagnosis`):

```prisma
model AiEventDiff {
  id        String   @id @default(cuid())
  eventAId  String // older event (by receivedAt)
  eventBId  String // newer event
  summary   String
  changes   Json // DiffChange[] — { path, kind, from?, to? }
  modelUsed String
  createdAt DateTime @default(now())

  eventA Event @relation("DiffEventA", fields: [eventAId], references: [id], onDelete: Cascade)
  eventB Event @relation("DiffEventB", fields: [eventBId], references: [id], onDelete: Cascade)

  @@unique([eventAId, eventBId])
}
```

- [ ] **Step 3: Create the migration and regenerate the client**

Make sure local Postgres is up (`docker compose up -d`), then run:

```bash
npm run db:migrate -- --name ai_event_diff
```

Expected: Prisma creates `prisma/migrations/<timestamp>_ai_event_diff/migration.sql`, applies it, and regenerates the client into `src/generated/prisma`. The output ends with "Your database is now in sync with your schema."

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(db): add AiEventDiff model for event-pair diff cache"
```

---

## Task 2: Pure logic — `explainEventDiff` and `canonicalPair`

**Files:**
- Create: `src/lib/ai/event-diff.ts`
- Test: `src/lib/ai/event-diff.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/ai/event-diff.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { explainEventDiff, canonicalPair, EventDiffError } from "./event-diff";

/** A fake Anthropic client whose messages.create returns a fixed text block
 *  and records the last request so tests can assert what was sent. */
function fakeClient(text: string) {
  const calls: Array<{ system?: unknown; messages: unknown }> = [];
  const client = {
    messages: {
      create: async (args: { system?: unknown; messages: unknown }) => {
        calls.push({ system: args.system, messages: args.messages });
        return { model: "model-from-api", content: [{ type: "text", text }] };
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

const VALID = JSON.stringify({
  summary: "amount rose and a coupon was added",
  changes: [
    { path: "$.amount", kind: "changed", from: "500", to: "1200" },
    { path: "$.metadata.coupon", kind: "added", to: "SAVE20" },
  ],
});

describe("explainEventDiff", () => {
  it("returns the parsed summary, changes, and model", async () => {
    const { client } = fakeClient(VALID);
    const res = await explainEventDiff({
      anthropic: client,
      bodyA: '{"amount":500}',
      bodyB: '{"amount":1200,"metadata":{"coupon":"SAVE20"}}',
    });
    expect(res.summary).toMatch(/amount/i);
    expect(res.changes).toHaveLength(2);
    expect(res.changes[0]).toEqual({
      path: "$.amount",
      kind: "changed",
      from: "500",
      to: "1200",
    });
    expect(res.modelUsed).toBe("model-from-api");
  });

  it("parses fenced JSON output", async () => {
    const { client } = fakeClient("```json\n" + VALID + "\n```");
    const res = await explainEventDiff({
      anthropic: client,
      bodyA: "{}",
      bodyB: "{}",
    });
    expect(res.changes).toHaveLength(2);
  });

  it("throws EventDiffError on non-JSON output", async () => {
    const { client } = fakeClient("sorry, I can't compare these");
    await expect(
      explainEventDiff({ anthropic: client, bodyA: "{}", bodyB: "{}" }),
    ).rejects.toThrow(EventDiffError);
  });

  it("caps each body to MAX_BODY_CHARS before sending", async () => {
    const huge = '{"x":"' + "a".repeat(20000) + '"}';
    const { client, calls } = fakeClient(VALID);
    await explainEventDiff({ anthropic: client, bodyA: huge, bodyB: huge });
    const sent = JSON.stringify(calls[0].messages);
    // Neither embedded body should carry the full 20k payload.
    expect(sent.length).toBeLessThan(20000);
  });
});

describe("canonicalPair", () => {
  it("orders older event as A regardless of argument order", () => {
    const older = { id: "old", receivedAt: new Date("2026-01-01") };
    const newer = { id: "new", receivedAt: new Date("2026-02-01") };
    expect(canonicalPair(newer, older)).toEqual({
      olderId: "old",
      newerId: "new",
    });
    expect(canonicalPair(older, newer)).toEqual({
      olderId: "old",
      newerId: "new",
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/ai/event-diff.test.ts`
Expected: FAIL — `Cannot find module './event-diff'`.

- [ ] **Step 3: Implement `src/lib/ai/event-diff.ts`**

```ts
import type Anthropic from "@anthropic-ai/sdk";

import { extractJsonText } from "./json";
import { MODEL_CHEAP } from "./models";

/** Thrown when the model's output can't be used as a diff (a user-facing,
 *  not infrastructure, failure). The action maps this to an inline error. */
export class EventDiffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventDiffError";
  }
}

export type DiffChange = {
  path: string;
  kind: "added" | "removed" | "changed";
  from?: string;
  to?: string;
};

export type DiffResult = {
  summary: string;
  changes: DiffChange[];
  modelUsed: string;
};

/** Cap each payload before embedding it in the prompt. ~6 KB each keeps the
 *  combined context bounded; webhook bodies above this are rare and a prefix
 *  is enough for a structural explanation. */
export const MAX_BODY_CHARS = 6000;

const SYSTEM_PROMPT = `You compare two webhook payloads (an older "A" and a newer "B") and explain, in plain English, what changed from A to B.

Respond with STRICT JSON only — no prose, no markdown, no code fences:
  { "summary": string, "changes": { "path": string, "kind": "added"|"removed"|"changed", "from"?: string, "to"?: string }[] }

- "summary" is one short plain-English sentence describing the overall change. If the two payloads are unrelated (different event shapes entirely), say so in the summary.
- "changes" lists concrete field-level differences. "path" is a JSONPath-lite string ("$.data.object.amount").
- "kind" is "added" (only in B), "removed" (only in A), or "changed" (different value).
- "from"/"to" are the stringified scalar values. Omit "from" for added fields and "to" for removed fields. For object/array values, give a brief summary string rather than dumping the whole structure.
- Report only meaningful differences; ignore values that are equal.`;

/** Pretty-print a JSON body for the prompt, falling back to the raw text, then
 *  cap it. Returns a string safe to embed in a fenced block. */
function prepBody(raw: string): string {
  let pretty = raw;
  try {
    pretty = JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    // non-JSON body: send the raw text as-is
  }
  return pretty.slice(0, MAX_BODY_CHARS);
}

export type ExplainEventDiffOpts = {
  anthropic: Anthropic;
  /** Older payload (raw request body as text). */
  bodyA: string;
  /** Newer payload (raw request body as text). */
  bodyB: string;
};

/**
 * Ask Claude to explain what changed from payload A (older) to payload B
 * (newer). Returns a structured diff. Throws EventDiffError if the model does
 * not return valid JSON.
 *
 * Trust boundary: the payload bodies are the user's own webhook data — already
 * shown to them in the dashboard — sent to their own BYOK Anthropic key. We cap
 * size but do not otherwise scrub; worst case is a less-useful explanation, not
 * code execution.
 */
export async function explainEventDiff(
  opts: ExplainEventDiffOpts,
): Promise<DiffResult> {
  const { anthropic, bodyA, bodyB } = opts;

  const content = [
    "Payload A (older):",
    "```json",
    prepBody(bodyA),
    "```",
    "",
    "Payload B (newer):",
    "```json",
    prepBody(bodyB),
    "```",
    "",
    "Output ONLY the JSON object describing what changed from A to B.",
  ].join("\n");

  const response = await anthropic.messages.create({
    model: MODEL_CHEAP,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new EventDiffError("the model did not return a usable response");
  }

  const raw = extractJsonText(textBlock.text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new EventDiffError(
      "the model did not return valid JSON — try again",
    );
  }

  const p = parsed as { summary?: unknown; changes?: unknown };
  const changes: DiffChange[] = Array.isArray(p.changes)
    ? p.changes.map((c) => {
        const ch = c as Record<string, unknown>;
        const kind =
          ch.kind === "added" || ch.kind === "removed" ? ch.kind : "changed";
        return {
          path: String(ch.path ?? ""),
          kind,
          ...(ch.from !== undefined ? { from: String(ch.from) } : {}),
          ...(ch.to !== undefined ? { to: String(ch.to) } : {}),
        };
      })
    : [];

  return {
    summary: String(p.summary ?? ""),
    changes,
    modelUsed: response.model,
  };
}

/** Given two events, return their ids ordered older→newer by receivedAt. Ties
 *  (equal timestamps) fall back to id ordering for a stable cache key. */
export function canonicalPair(
  a: { id: string; receivedAt: Date },
  b: { id: string; receivedAt: Date },
): { olderId: string; newerId: string } {
  const aFirst =
    a.receivedAt.getTime() < b.receivedAt.getTime() ||
    (a.receivedAt.getTime() === b.receivedAt.getTime() && a.id < b.id);
  return aFirst
    ? { olderId: a.id, newerId: b.id }
    : { olderId: b.id, newerId: a.id };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/ai/event-diff.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/event-diff.ts src/lib/ai/event-diff.test.ts
git commit -m "feat(ai): explainEventDiff + canonicalPair pure logic"
```

---

## Task 3: Server action — `explainEventDiffAction`

**Files:**
- Create: `src/lib/actions/event-diff.ts`

- [ ] **Step 1: Implement the action**

Create `src/lib/actions/event-diff.ts`:

```ts
"use server";

import { revalidatePath } from "next/cache";

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { anthropicFor } from "@/lib/anthropic";
import {
  explainEventDiff,
  canonicalPair,
  type DiffChange,
  type DiffResult,
} from "@/lib/ai/event-diff";

async function requireUserId(): Promise<string> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("unauthorized");
  return session.user.id;
}

/** What the UI consumes — the persisted/diff fields without the model id. */
export type EventDiffView = { summary: string; changes: DiffChange[] };

/**
 * Explain what changed between two events the user owns. Canonicalizes the
 * pair older→newer, returns a cached AiEventDiff if one exists, otherwise calls
 * Claude (BYOK) and persists the result. Re-opening the same compare URL is
 * free after the first generation.
 */
export async function explainEventDiffAction(
  aId: string,
  bId: string,
): Promise<EventDiffView> {
  const userId = await requireUserId();

  if (aId === bId) throw new Error("cannot compare an event with itself");

  const events = await prisma.event.findMany({
    where: { id: { in: [aId, bId] }, source: { userId } },
    select: { id: true, receivedAt: true, bodyRaw: true },
  });
  if (events.length !== 2) throw new Error("event not found");

  const [e0, e1] = events;
  const { olderId, newerId } = canonicalPair(e0, e1);
  const older = e0.id === olderId ? e0 : e1;
  const newer = e0.id === newerId ? e0 : e1;

  // Cache hit — return without spending tokens.
  const cached = await prisma.aiEventDiff.findUnique({
    where: { eventAId_eventBId: { eventAId: olderId, eventBId: newerId } },
  });
  if (cached) {
    return {
      summary: cached.summary,
      changes: cached.changes as unknown as DiffChange[],
    };
  }

  const anthropic = await anthropicFor(userId);
  const result: DiffResult = await explainEventDiff({
    anthropic,
    bodyA: older.bodyRaw,
    bodyB: newer.bodyRaw,
  });

  await prisma.aiEventDiff.create({
    data: {
      eventAId: olderId,
      eventBId: newerId,
      summary: result.summary,
      changes: result.changes as unknown as object,
      modelUsed: result.modelUsed,
    },
  });

  revalidatePath("/events/compare");
  return { summary: result.summary, changes: result.changes };
}
```

- [ ] **Step 2: Type-check the new action**

Run: `npx tsc --noEmit`
Expected: no errors referencing `src/lib/actions/event-diff.ts`. (Pre-existing unrelated errors, if any, can be ignored — but this file must be clean.)

- [ ] **Step 3: Commit**

```bash
git add src/lib/actions/event-diff.ts
git commit -m "feat(actions): explainEventDiffAction with per-pair cache"
```

---

## Task 4: Client component — `ExplainDiffButton`

**Files:**
- Create: `src/components/explain-diff-button.tsx`

- [ ] **Step 1: Implement the button**

Create `src/components/explain-diff-button.tsx` (skeleton mirrors `diagnose-button.tsx`):

```tsx
"use client";

import { useState, useTransition } from "react";

import {
  explainEventDiffAction,
  type EventDiffView,
} from "@/lib/actions/event-diff";

type Props = {
  aId: string;
  bId: string;
  hasApiKey: boolean;
  initialResult?: EventDiffView | null;
};

const KIND_LABEL: Record<string, string> = {
  added: "added",
  removed: "removed",
  changed: "changed",
};

const KIND_CLASS: Record<string, string> = {
  added: "text-emerald-700 dark:text-emerald-300",
  removed: "text-red-700 dark:text-red-300",
  changed: "text-amber-700 dark:text-amber-300",
};

export function ExplainDiffButton({
  aId,
  bId,
  hasApiKey,
  initialResult,
}: Props) {
  const [result, setResult] = useState<EventDiffView | null>(
    initialResult ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleClick() {
    setError(null);
    startTransition(async () => {
      try {
        const res = await explainEventDiffAction(aId, bId);
        setResult(res);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  }

  if (result) {
    return (
      <div className="rounded-md border border-indigo-300 bg-indigo-50 p-4 text-sm dark:border-indigo-900 dark:bg-indigo-950">
        <div className="font-medium text-indigo-900 dark:text-indigo-100">
          What changed (Claude)
        </div>
        <p className="mt-1 text-indigo-900 dark:text-indigo-100">
          {result.summary}
        </p>
        {result.changes.length > 0 && (
          <ul className="mt-3 space-y-1 font-mono text-xs">
            {result.changes.map((c, i) => (
              <li key={i} className="flex flex-wrap items-baseline gap-2">
                <span className="text-indigo-900 dark:text-indigo-100">
                  {c.path}
                </span>
                <span className={KIND_CLASS[c.kind]}>
                  {KIND_LABEL[c.kind]}
                </span>
                {c.kind === "changed" && (
                  <span className="text-indigo-700 dark:text-indigo-300">
                    {c.from} → {c.to}
                  </span>
                )}
                {c.kind === "added" && (
                  <span className="text-indigo-700 dark:text-indigo-300">
                    {c.to}
                  </span>
                )}
                {c.kind === "removed" && (
                  <span className="text-indigo-700 dark:text-indigo-300">
                    {c.from}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={handleClick}
        disabled={!hasApiKey || isPending}
        className="inline-flex h-8 items-center rounded-md border border-indigo-300 bg-indigo-50 px-3 text-xs font-medium text-indigo-900 hover:bg-indigo-100 disabled:opacity-60 dark:border-indigo-900 dark:bg-indigo-950 dark:text-indigo-100"
        title={
          hasApiKey
            ? "Ask Claude to explain what changed"
            : "Add a Claude API key in Settings to enable"
        }
      >
        {isPending ? "Explaining…" : "Explain with Claude"}
      </button>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors referencing `explain-diff-button.tsx`.

- [ ] **Step 3: Commit**

```bash
git add src/components/explain-diff-button.tsx
git commit -m "feat(ui): ExplainDiffButton client component"
```

---

## Task 5: Compare page — `/events/compare`

**Files:**
- Create: `src/app/(dashboard)/events/compare/page.tsx`

- [ ] **Step 1: Implement the page**

Create `src/app/(dashboard)/events/compare/page.tsx`:

```tsx
import { notFound } from "next/navigation";
import Link from "next/link";

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { canonicalPair, type DiffChange } from "@/lib/ai/event-diff";
import { ExplainDiffButton } from "@/components/explain-diff-button";

export const dynamic = "force-dynamic";

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

export default async function CompareEventsPage({
  searchParams,
}: {
  searchParams: Promise<{ a?: string; b?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) return null;

  const { a, b } = await searchParams;
  if (!a || !b || a === b) notFound();

  const events = await prisma.event.findMany({
    where: { id: { in: [a, b] }, source: { userId: session.user.id } },
    include: { source: { select: { name: true } } },
  });
  if (events.length !== 2) notFound();

  const [e0, e1] = events;
  const { olderId, newerId } = canonicalPair(e0, e1);
  const older = e0.id === olderId ? e0 : e1;
  const newer = e0.id === newerId ? e0 : e1;

  const hasApiKey = !!(await prisma.userApiKey.findUnique({
    where: { userId: session.user.id },
    select: { userId: true },
  }));

  const cached = await prisma.aiEventDiff.findUnique({
    where: { eventAId_eventBId: { eventAId: olderId, eventBId: newerId } },
  });
  const initialResult = cached
    ? {
        summary: cached.summary,
        changes: cached.changes as unknown as DiffChange[],
      }
    : null;

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/events"
          className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
        >
          ← Back to events
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">
          Compare events
        </h1>
        <p className="mt-1 text-sm text-zinc-500">
          Older → newer, by received time.
        </p>
      </div>

      <ExplainDiffButton
        aId={olderId}
        bId={newerId}
        hasApiKey={hasApiKey}
        initialResult={initialResult}
      />

      <section className="grid gap-6 lg:grid-cols-2">
        {[older, newer].map((ev, idx) => (
          <div
            key={ev.id}
            className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-900"
          >
            <div className="border-b border-zinc-200 px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500 dark:border-zinc-700">
              {idx === 0 ? "A · older" : "B · newer"} · {ev.source.name}
            </div>
            <p className="break-all px-4 pt-2 font-mono text-xs text-zinc-500">
              {ev.id} · {ev.receivedAt.toISOString()}
            </p>
            <pre className="max-h-[28rem] overflow-auto p-4 font-mono text-xs">
              {prettyJson(ev.bodyRaw)}
            </pre>
          </div>
        ))}
      </section>
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors referencing `events/compare/page.tsx`.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(dashboard)/events/compare/page.tsx"
git commit -m "feat(ui): /events/compare page with side-by-side payloads"
```

---

## Task 6: "Compare with AI" button in the bulk-actions bar

**Files:**
- Modify: `src/components/events-bulk-actions.tsx`

- [ ] **Step 1: Add a navigation helper**

In `src/components/events-bulk-actions.tsx`, the component already has `const router = useRouter();` and `const [selected, setSelected] = useState<Set<string>>(new Set());`. Add this handler alongside `runReplay` / `runCancel` (after `runCancel`):

```tsx
  function goCompare() {
    const [a, b] = Array.from(selected);
    router.push(`/events/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`);
  }
```

- [ ] **Step 2: Add the button to the bulk bar**

In the sticky bar's button row, immediately before the existing "Replay" button (the `<button ... onClick={runReplay} ...>` element), insert:

```tsx
        <button
          type="button"
          onClick={goCompare}
          disabled={busyAny || selected.size !== 2}
          title={
            selected.size === 2
              ? "Explain what changed between the two selected events"
              : "Select exactly two events to compare"
          }
          className="inline-flex h-8 items-center rounded-md border border-indigo-300 bg-indigo-50 px-3 text-xs font-medium text-indigo-900 hover:bg-indigo-100 disabled:opacity-60 dark:border-indigo-900 dark:bg-indigo-950 dark:text-indigo-100"
        >
          Compare with AI
        </button>
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/events-bulk-actions.tsx
git commit -m "feat(ui): Compare with AI button (enabled at exactly 2 selected)"
```

---

## Task 7: Full test + lint pass and manual verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full unit-test suite**

Run: `npm test`
Expected: all tests pass, including the new `src/lib/ai/event-diff.test.ts`.

- [ ] **Step 2: Type-check the whole project**

Run: `npx tsc --noEmit`
Expected: no errors in any of the new/modified files.

- [ ] **Step 3: Lint (if the project lints in CI)**

Run: `npm run lint`
Expected: no new lint errors. (If `lint` script is absent, skip.)

- [ ] **Step 4: Manual end-to-end check**

1. `docker compose up -d` (Postgres/Redis/MailHog), then `npm run dev`.
2. Sign in via MailHog (`http://localhost:8025`). Ensure a Claude API key is set at Settings → API Keys (the button is disabled without one).
3. Ingest two slightly different payloads to the same source:
   ```bash
   curl -X POST http://localhost:3000/api/ingest/<slug> -H 'content-type: application/json' -d '{"amount":500}'
   curl -X POST http://localhost:3000/api/ingest/<slug> -H 'content-type: application/json' -d '{"amount":1200,"metadata":{"coupon":"SAVE20"}}'
   ```
4. On `/events`, select both events → the "Compare with AI" button enables (only at exactly 2).
5. Click it → land on `/events/compare?a=…&b=…` with both payloads side-by-side (A older, B newer).
6. Click "Explain with Claude" → verify the summary + changes list (`$.amount changed 500 → 1200`, `$.metadata.coupon added`).
7. Refresh the page → the explanation is present immediately (served from the `AiEventDiff` cache, no new token spend).
8. Confirm visiting `/events/compare?a=<id>&b=<id>` with the ids swapped renders the same A/B ordering and hits the same cache row.

- [ ] **Step 5: Final commit (if any verification fixes were needed)**

```bash
git add -A
git commit -m "chore: verification fixes for AI event diffs"
```

---

## Self-Review notes

- **Spec coverage:** model + migration (Task 1) ✓; pure logic + cache key (Task 2) ✓; action with ownership guard + cache (Task 3) ✓; gated client button (Task 4) ✓; dedicated page with notFound guards + side-by-side payloads (Task 5) ✓; bulk-bar entry at exactly-2 (Task 6) ✓; tests + manual verification (Tasks 2 & 7) ✓. Cross-source allowed (no same-source check anywhere) ✓. Older→newer canonicalization shared by action and page via `canonicalPair` ✓.
- **Type consistency:** `DiffResult` (lib) carries `modelUsed`; `EventDiffView` (action/UI) is `{ summary, changes }`; `DiffChange` is the shared change type. The page imports `DiffChange` from the lib and `ExplainDiffButton` from the component; `EventDiffView` is imported by the component from the action. Compound unique accessor `eventAId_eventBId` matches the `@@unique([eventAId, eventBId])` in Task 1.
- **No placeholders:** the one intentional placeholder import in Task 5 Step 1 is explicitly removed in Step 2.
```
