# AI-explained event diffs (#11) — Design

**Date:** 2026-06-01
**Status:** Approved, ready for implementation plan
**Source:** Tier 3 of the competitor gap analysis (`~/.claude/plans/ok-as-you-can-concurrent-engelbart.md`, item #11). Follows #10 (AI test fixtures, PR #7).

## Goal

Let a user pick **two events** and get Claude's plain-English explanation of what changed between their payloads — e.g. "`amount` went from 500 to 1200; `metadata.coupon` is new." Extends the existing nightly schema-drift detection from "drift happened" to "here's exactly what drifted, in English," on demand, between two concrete payloads the user chooses.

This is a UI-only, BYOK feature. It reuses the established AI-feature pattern in the codebase: pure logic in `src/lib/ai/*`, a server action that caches the result on a DB row, and a small client button gated on `hasApiKey`.

## Decisions (locked during brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| Pairing model | User picks any two events | Maximum flexibility; reuses existing multi-select on the events list. |
| Entry point | "Compare with AI" button in the events bulk-actions bar, enabled only when exactly 2 selected | No new selection UI — `EventsBulkActions` already tracks selection state. |
| Result surface | Dedicated page `/events/compare?a=<id>&b=<id>` | Shareable/bookmarkable; room for side-by-side payloads; matches the existing "Inspect →" navigation idiom. |
| Token spend on render | Page renders payloads + an **Explain with Claude** button; the button (not page render) triggers the AI call | Avoids spending tokens on every page load/refresh. Same interaction model as the diagnose button. |
| Caching | New `AiEventDiff` model keyed on the ordered `(eventA, eventB)` pair | Respects BYOK token economy; mirrors how diagnose caches on the delivery row. |
| Direction | Canonicalize older→newer by `receivedAt`: A = older, B = newer | "What changed" reads chronologically; `(x,y)` and `(y,x)` collapse to one cache row. |
| Model | `MODEL_CHEAP` | Structured diff task — same model the drift feature uses. |
| Output shape | `{ summary, changes[] }` where each change is `{ path, kind, from?, to? }` | Concrete, value-level diffs; one-line plain-English summary. |
| Cross-source pairs | Allowed | Enforcing same-source adds friction for no safety gain; Claude just notes unrelated payloads. |

## Data flow

```
events list (EventsBulkActions, exactly 2 selected)
   → "Compare with AI" → /events/compare?a=<id>&b=<id>
        page (server component):
          - load both events (must be owned by session user; notFound otherwise)
          - notFound if a === b
          - sort by receivedAt → A = older, B = newer
          - render both payloads side-by-side + <ExplainDiffButton> (seeded w/ cached result)
        → explainEventDiffAction(aId, bId)
            - auth + ownership guard
            - canonicalize older→newer
            - cache hit on AiEventDiff(@@unique[eventAId, eventBId])? return it
            - else anthropicFor(userId) → explainEventDiff({ anthropic, bodyA, bodyB })
                   → persist AiEventDiff → return
```

## Components & files

### New — pure logic: `src/lib/ai/event-diff.ts`
Mirrors `src/lib/ai/fixtures.ts` and `src/lib/ai/drift.ts`.

- Export `explainEventDiff({ anthropic, bodyA, bodyB }): Promise<DiffResult>`.
- Pretty-prints both payloads, caps each to ~6 KB (`MAX_BODY_CHARS`) to bound prompt size, embeds them in the user message.
- Calls `MODEL_CHEAP`, `max_tokens` ~1024.
- System prompt instructs STRICT JSON only:
  ```json
  {
    "summary": "one plain-English sentence",
    "changes": [
      { "path": "$.amount", "kind": "changed", "from": "500", "to": "1200" },
      { "path": "$.metadata.coupon", "kind": "added", "to": "SAVE20" }
    ]
  }
  ```
  - `kind` ∈ `"added" | "removed" | "changed"`.
  - `from`/`to` are stringified scalar values (omit `from` for added, `to` for removed). Object/array values summarized briefly rather than dumped in full.
- Reuses the existing JSON extraction (`extractJsonText`) + `JSON.parse` guard idiom; throws a typed `EventDiffError` (user-facing 400-class failure) when output is unparseable. Includes the same trust-boundary comment as `fixtures.ts` (payloads are the user's own data, already shown in the UI, sent to their own BYOK key — capped, not otherwise scrubbed).

**Types:**
```ts
export type DiffChange = {
  path: string;
  kind: "added" | "removed" | "changed";
  from?: string;
  to?: string;
};
export type DiffResult = { summary: string; changes: DiffChange[] };
```

### New — server action: `src/lib/actions/event-diff.ts`
`"use server"`, mirrors `src/lib/actions/diagnose.ts`.

- `explainEventDiffAction(aId: string, bId: string): Promise<DiffResult>`.
- `requireUserId()` (same helper pattern).
- Load both events with `where: { id, source: { userId } }` (ownership). Throw if either missing.
- Canonicalize: order the two by `receivedAt` → `(olderId, newerId)`.
- Cache read: `prisma.aiEventDiff.findUnique({ where: { eventAId_eventBId: { eventAId: olderId, eventBId: newerId } } })`. If present, return `{ summary, changes }`.
- Else `anthropicFor(userId)` → `explainEventDiff(...)` → `prisma.aiEventDiff.create(...)` → `revalidatePath('/events/compare')` → return.

### New — page: `src/app/(dashboard)/events/compare/page.tsx`
Server component, `export const dynamic = "force-dynamic"`.

- Read `a` / `b` from `searchParams`.
- `auth()`; if no session, `return null` (consistent with the event detail page).
- `notFound()` if `a`/`b` missing, equal, or either event not owned.
- Sort the two events older→newer for display labels (A = older, B = newer).
- Render: a back link to `/events`, both payloads side-by-side (reuse the `prettyJson` helper idiom from the event detail page), and `<ExplainDiffButton aId={olderId} bId={newerId} hasApiKey initialResult={cachedOrNull} />`.
- Look up `hasApiKey` via `prisma.userApiKey.findUnique` (same as event detail page).
- Look up any cached `AiEventDiff` to seed the button.

### New — client component: `src/components/explain-diff-button.tsx`
`"use client"`, same skeleton as `src/components/diagnose-button.tsx`.

- Props: `{ aId, bId, hasApiKey, initialResult?: DiffResult | null }`.
- `useTransition`; on click calls `explainEventDiffAction(aId, bId)`.
- Renders `summary` prominently and the `changes[]` as a list (e.g. `path` · `kind` · `from → to`), with added/removed/changed visually distinguished. Error displayed inline.
- Disabled with the "Add a Claude API key in Settings to enable" tooltip when `!hasApiKey`, matching diagnose.

### Edited — `src/components/events-bulk-actions.tsx`
- Add a **Compare with AI** button to the sticky bulk-actions bar.
- Enabled only when `selected.size === 2`; otherwise disabled.
- On click, navigate (`router.push`) to `/events/compare?a=<id1>&b=<id2>` using the two selected ids (order doesn't matter — the page canonicalizes).
- Purely additive; does not touch existing replay/cancel logic or selection state.

### Edited — `prisma/schema.prisma` (+ migration)
```prisma
model AiEventDiff {
  id        String   @id @default(cuid())
  eventAId  String   // older event (by receivedAt)
  eventBId  String   // newer event
  summary   String
  changes   Json     // DiffChange[]
  modelUsed String
  createdAt DateTime @default(now())
  eventA    Event    @relation("DiffEventA", fields: [eventAId], references: [id], onDelete: Cascade)
  eventB    Event    @relation("DiffEventB", fields: [eventBId], references: [id], onDelete: Cascade)
  @@unique([eventAId, eventBId])
}
```
- Add back-relations on `Event`: `diffsAsA AiEventDiff[] @relation("DiffEventA")`, `diffsAsB AiEventDiff[] @relation("DiffEventB")`.
- `onDelete: Cascade` so diffs disappear with either event.
- Run `npm run db:migrate` to create the migration; Prisma client output regenerates to `src/generated/prisma`.

## Error handling

| Condition | Behavior |
|---|---|
| Either event not owned / missing / `a === b` | Page `notFound()`. |
| No Anthropic key | Button disabled, tooltip points to Settings → API Keys. Action also throws `NoUserApiKeyError` defensively. |
| Model returns unparseable output | `EventDiffError` thrown; surfaced inline in the button; nothing persisted. |
| Cache hit | Returned without spending tokens. |

## Testing (Vitest)

Mirror `src/lib/ai/fixtures.test.ts`:

- **`src/lib/ai/event-diff.test.ts`** — mocked `Anthropic` client:
  - valid JSON → parsed `DiffResult` (summary + typed changes);
  - non-JSON / fenced output → handled by `extractJsonText`, and pure garbage → `EventDiffError`;
  - oversized bodies are capped to `MAX_BODY_CHARS`.
- **Action-level** (`src/lib/actions/event-diff.test.ts` if the codebase tests actions; otherwise fold into the lib test):
  - cache-hit path returns stored row without calling Anthropic;
  - ownership guard rejects an event the user doesn't own;
  - older→newer canonicalization produces a stable cache key regardless of argument order.

## Scope guardrails (YAGNI — explicitly out)

- No JSON syntax-highlighting or colorized structural diff library — plain `<pre>` side-by-side.
- No "compare against predecessor" one-click shortcut on the event detail page (the picked-pair flow covers it).
- No CLI surface and no `/api/v1` endpoint — UI only, exactly as diagnose stayed UI-only.
- No same-source enforcement.
- No batching / multi-event (>2) comparison.

## Verification (manual, post-implementation)

Per the gap-analysis plan's verification notes:
1. `docker compose up -d` (pg/redis/mailhog); `npm run dev`; sign in via MailHog (`localhost:8025`).
2. Ingest two slightly different payloads to the same source via `curl -X POST http://localhost:3000/api/ingest/<slug>`.
3. On `/events`, select both, click **Compare with AI** → land on `/events/compare`.
4. Click **Explain with Claude** (requires a BYOK key in Settings) → verify the summary + changes list match the actual differences.
5. Refresh the page → result loads from cache (no second token spend; confirm via Anthropic usage or by asserting the same `createdAt`).
