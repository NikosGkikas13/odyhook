# Multi-provider BYOK — design

**Date:** 2026-06-08
**Status:** Approved (design); pending implementation plan
**Goal:** Let users power Odyhook's AI features with any major LLM provider — not just Anthropic — by bringing their own key.

---

## Problem

Every AI feature (filters, transforms, failure diagnosis, weekly digest, drift
check, NL event search, event diffs, fixture generation) is hard-wired to
Anthropic. The client wrapper [`src/lib/anthropic.ts`](../../../src/lib/anthropic.ts)
returns a `@anthropic-ai/sdk` instance, the single `UserApiKey.anthropicKeyEnc`
column stores one Anthropic key per user, and all 8 modules call
`anthropic.messages.create(...)` directly. Users who prefer OpenAI, Google
Gemini, or anything else cannot use the AI features at all.

We want anyone, on any mainstream LLM, to use the features.

## Why this is tractable

All 8 AI modules use the **same minimal call shape**: a system prompt plus
user message(s) in, a single text block out, from which existing helpers
(`extractJsonText`) parse JSON. **No tool-calling, no streaming, no
multimodal.** That means the provider abstraction is a single tiny "prompt in,
text out" interface — not a rewrite of each feature.

## Goals

- Native support for **Anthropic, OpenAI, Google Gemini**, plus **OpenRouter**
  as a catch-all aggregator (one OpenRouter key → hundreds of models). Four
  adapters cover essentially every model on the market.
- A user can **store keys for several providers** and **switch the active one**
  without re-pasting.
- Preserve the existing two-tier cost optimization (a "cheap" model for the
  weekly digest, a "standard" model for everything else) **automatically**, via
  curated per-provider model defaults — **no per-feature model picker.**
- Migrate existing production Anthropic keys with **zero user-facing
  disruption.**

## Non-goals (YAGNI)

- No live "test this key" validation call (format check only).
- No per-feature or per-call model selection UI.
- No native adapters beyond the big three (OpenRouter covers the long tail).
- No streaming / tool-calling / multimodal abstraction — not used by any
  feature.

## Decisions (locked during brainstorming)

| Question | Decision |
|---|---|
| Provider breadth | Anthropic + OpenAI + Google **native**, plus **OpenRouter** catch-all |
| Model selection | **Curated per-provider defaults**, no picker (OpenRouter: user names one model) |
| Key storage / switching | **Save many, pick active** (row per provider + active pointer) |
| Implementation style | **Native SDKs behind a thin `LlmClient` interface** (not the Vercel AI SDK) |

---

## Architecture

### New module: `src/lib/llm/`

A single interface shaped to what the modules already do:

```ts
// src/lib/llm/types.ts
export type Tier = "standard" | "cheap";
export type Provider = "anthropic" | "openai" | "google" | "openrouter";

export interface CompleteArgs {
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  maxTokens: number;
  tier: Tier;          // adapter resolves tier → concrete model id
}

export interface LlmClient {
  readonly provider: Provider;
  complete(args: CompleteArgs): Promise<string>;  // returns the text block
}
```

### Adapters (one file each, ~15–25 lines)

- `adapters/anthropic.ts` — wraps `@anthropic-ai/sdk`; lifts the existing
  `messages.create` + `content.find(b => b.type === "text").text` logic
  verbatim.
- `adapters/openai.ts` — `openai` SDK; `chat.completions.create` with
  `[{ role: "system", content: system }, ...messages]`; returns
  `choices[0].message.content`.
- `adapters/openrouter.ts` — **reuses the `openai` SDK** with
  `baseURL: "https://openrouter.ai/api/v1"` and the user's chosen model id
  (so three SDKs cover four providers).
- `adapters/google.ts` — `@google/genai`; `generateContent`; returns `.text`.

New dependencies: `openai`, `@google/genai`. `@anthropic-ai/sdk` stays.

### Curated model table — replaces `src/lib/ai/models.ts`

```ts
// src/lib/llm/models.ts
export const PROVIDER_MODELS: Record<
  Exclude<Provider, "openrouter">,
  Record<Tier, string>
> = {
  anthropic: { standard: "claude-sonnet-4-6", cheap: "claude-haiku-4-5-20251001" },
  openai:    { standard: "gpt-5",             cheap: "gpt-5-mini" },
  google:    { standard: "gemini-2.5-pro",    cheap: "gemini-2.5-flash" },
};
// OpenRouter: no curated pair — the user's single chosen model id is used for
// BOTH tiers.
```

> Exact model ids are verified against each provider's current lineup at
> implementation. The Anthropic pair is carried over unchanged from the
> existing `models.ts` and re-confirmed via the `claude-api` skill.

### Factory — replaces `anthropicFor`

[`src/lib/anthropic.ts`](../../../src/lib/anthropic.ts) becomes `src/lib/llm/index.ts`:

- `llmFor(userId): Promise<LlmClient>` — reads the user's **active** provider
  and that provider's key, constructs the matching adapter. Throws
  `NoLlmKeyError` when none is configured.
- `getActiveLlm(userId): Promise<{ provider, key, model? } | null>` — replaces
  `getUserApiKey`, for routes that build a client inline (e.g. the fixtures
  route).

### Refactoring the 8 modules + call sites (mechanical, uniform)

Two existing client-acquisition patterns, both collapse:

- **Self-serve modules** (`drift`, `digest`, `diagnose`, `rule-compiler`,
  `transform`): `const anthropic = await anthropicFor(userId)` →
  `const llm = await llmFor(userId)`.
- **Injected-client modules** (`fixtures`, `event-diff`, `search-compiler`):
  the `anthropic: Anthropic` param becomes `llm: LlmClient`. Callers — the
  fixtures route, [`src/lib/services/search.ts`](../../../src/lib/services/search.ts),
  [`src/lib/actions/event-diff.ts`](../../../src/lib/actions/event-diff.ts) —
  build it via `llmFor`.

The call body in every module changes the same way:

```ts
// before
const response = await anthropic.messages.create({
  model: MODEL_DEFAULT, max_tokens: 1024, system, messages,
});
const textBlock = response.content.find((b) => b.type === "text");
const raw = extractJsonText(textBlock.text);

// after
const raw = extractJsonText(
  await llm.complete({ tier: "standard", maxTokens: 1024, system, messages }),
);
```

`digest` and `drift` pass `tier: "cheap"`. **`extractJsonText` and all
downstream parsing are untouched** — adapters always return a plain string.

---

## Data model + migration

Replace `UserApiKey` with a per-provider table and an active pointer on `User`:

```prisma
model ProviderKey {
  userId    String
  provider  String   // "anthropic" | "openai" | "google" | "openrouter"
  keyEnc    String   // AES-256-GCM, same ENCRYPTION_KEY as today
  model     String?  // OpenRouter only (user-chosen model id)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@id([userId, provider])
}

// User gains:
//   activeAiProvider String?   // null = no AI configured
```

**Migration** — one Prisma migration, data-preserving, raw SQL for the copy:

1. Create `ProviderKey`; add `User.activeAiProvider`.
2. `INSERT INTO "ProviderKey" (userId, provider, keyEnc, model, createdAt, updatedAt)
   SELECT "userId", 'anthropic', "anthropicKeyEnc", NULL, "createdAt", "updatedAt"
   FROM "UserApiKey";`
3. `UPDATE "User" SET "activeAiProvider" = 'anthropic'
   WHERE "id" IN (SELECT "userId" FROM "UserApiKey");`
4. `DROP TABLE "UserApiKey";`

Existing encrypted keys decrypt unchanged (same `ENCRYPTION_KEY`, same crypto
module). No user re-entry required.

---

## Settings → API Keys

The page ([`src/app/(dashboard)/settings/api-keys/page.tsx`](../../../src/app/(dashboard)/settings/api-keys/page.tsx))
becomes a small multi-provider manager:

- **Configured-providers list** — providers with a saved key, the active one
  marked, with a control to switch active (only among saved keys).
- **Add / replace key form** — provider dropdown + key input; a **model field
  shown only when provider = OpenRouter.**
- **Remove** button per provider.

Server actions ([`src/lib/actions/api-keys.ts`](../../../src/lib/actions/api-keys.ts)):

- `saveProviderKey(formData)` — per-provider key-format check
  (`sk-ant-` / `sk-` / `AIza` / `sk-or-`), require `model` when OpenRouter,
  encrypt, upsert the `ProviderKey` row; if the user has no active provider
  yet, set this one active.
- `setActiveProvider(formData)` — switch active (must own a saved key for it).
- `deleteProviderKey(formData)` — delete the row; if it was the active one,
  repoint `activeAiProvider` to another saved key, else `null`.

Format checks are soft (helpful errors), not security boundaries. No live
validation ping.

---

## Error handling

`NoUserApiKeyError` → `NoLlmKeyError` — message: "No AI provider configured —
add a key in Settings → API Keys." Update every catch site (API routes +
server actions that translate it into a user-facing message); the exact list
is enumerated in the implementation plan.

---

## Docs

Make BYOK provider-agnostic wherever it currently says "Anthropic key":

- Feature docs: `docs/ai-filters-and-transforms`, `docs/ai-event-diffs`,
  `docs/nl-event-search`, the MCP BYOK-tools note (`docs/mcp`), `docs/cli`.
- Settings page copy.
- Marketing `security` and `subprocessors` pages ("Anthropic keys" → "your LLM
  provider key — Anthropic, OpenAI, Google, or OpenRouter").
- The "Anthropic is BYOK" decision-log note in `infra/README.md` and the BYOK
  row in `ARCHITECTURE.md`.
- A `changelog` entry.

---

## Testing

- **Adapter unit tests** — mock each SDK; assert args→SDK-call mapping and text
  extraction (mirrors existing `fixtures.test.ts` / `event-diff.test.ts`).
- **Existing module tests simplify** — they currently inject a fake Anthropic
  client; they inject a fake `LlmClient` (stub one `complete`), removing
  SDK-shape mocking.
- **Factory test** — `llmFor` selects the adapter matching `activeAiProvider`;
  throws `NoLlmKeyError` when none.
- **Settings-action tests** — per-provider validation, OpenRouter-requires-
  model, active-pointer repoint on delete.
- `tsc --noEmit` + full Vitest suite must pass (the CI deploy gate).

---

## Rollout / safety

- Single migration, data-preserving; existing Anthropic users keep working with
  no action.
- No `.env` changes required (keys remain per-user, encrypted). `PROVIDER_MODELS`
  are code constants.
- Backwards compatible at the feature level: a user with only an Anthropic key
  behaves exactly as before.
