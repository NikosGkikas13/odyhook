# Multi-provider BYOK Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users power Odyhook's AI features with any major LLM provider (Anthropic, OpenAI, Google Gemini) plus OpenRouter as a catch-all, by bringing their own key.

**Architecture:** A thin `LlmClient` interface (`complete({system, messages, maxTokens, tier}) → {text, model}`) with four native adapters behind it. The 8 AI modules call `llmFor(userId)` (or receive an injected `LlmClient`) instead of constructing an Anthropic SDK client. Keys move from the single-column `UserApiKey` table to a per-provider `ProviderKey` table plus a `User.activeAiProvider` pointer.

**Tech Stack:** TypeScript (strict), Next.js 16 App Router, Prisma 7 (`@prisma/adapter-pg`), Vitest 4, `@anthropic-ai/sdk` (existing), `openai` + `@google/genai` (new).

---

## Spec

Design doc: [docs/superpowers/specs/2026-06-08-multi-provider-byok-design.md](../specs/2026-06-08-multi-provider-byok-design.md)

## Provider API verification (read before Tasks 2–5)

Adapter code below is concrete, but provider SDKs and model ids drift. Before writing each adapter, confirm against the **installed** SDK and current docs:

- **Anthropic** model ids via the `claude-api` skill (carried over unchanged from the current `models.ts`).
- **OpenAI**: token param is `max_completion_tokens` for current models (gpt-5 family). Check `node_modules/openai` types for `chat.completions.create`.
- **OpenRouter**: OpenAI-compatible; uses `max_tokens`. Base URL `https://openrouter.ai/api/v1`.
- **Google**: check `node_modules/@google/genai` for `models.generateContent({ model, contents, config })` and the response `.text` accessor.

If a model id or param differs from what's written, use the verified value — the surrounding structure stays the same.

## File structure

**New (`src/lib/llm/`):**
- `types.ts` — `Provider`, `Tier`, `CompleteArgs`, `CompleteResult`, `LlmClient`.
- `models.ts` — `PROVIDER_MODELS` curated table + `OPENROUTER_BASE_URL`.
- `errors.ts` — `NoLlmKeyError`.
- `adapters/anthropic.ts`, `adapters/openai.ts`, `adapters/openrouter.ts`, `adapters/google.ts`.
- `index.ts` — `buildLlmClient(cfg)` (pure) + `llmFor(userId)` (DB-backed). Re-exports types + `NoLlmKeyError`.
- Tests: `adapters/*.test.ts`, `index.test.ts`.

**Deleted:** `src/lib/anthropic.ts`, `src/lib/ai/models.ts`.

**Modified:** the 8 AI modules, 3 call sites (`fixtures` route, `services/search.ts`, `actions/event-diff.ts`), 3 error sites (`events/search` route, `actions/search.ts`, `mcp/server.ts`), `prisma/schema.prisma` (+ migration), Settings page + `actions/api-keys.ts`, docs.

---

## Task 1: Add provider SDK dependencies

**Files:**
- Modify: `package.json`, `package-lock.json`

- [ ] **Step 1: Install the two new SDKs**

Run: `npm install openai @google/genai`
Expected: `package.json` gains `openai` and `@google/genai` under `dependencies`; lockfile updates; exit 0.

- [ ] **Step 2: Confirm the build still typechecks**

Run: `npx tsc --noEmit`
Expected: exit 0 (no usages yet).

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "build: add openai + @google/genai SDKs for multi-provider BYOK"
```

---

## Task 2: LlmClient types + model table + error

**Files:**
- Create: `src/lib/llm/types.ts`
- Create: `src/lib/llm/models.ts`
- Create: `src/lib/llm/errors.ts`

- [ ] **Step 1: Write `types.ts`**

```ts
// src/lib/llm/types.ts
// The provider-agnostic surface every AI feature talks to. Shaped to exactly
// what the modules already do: a system prompt + user turns in, one text block
// out (plus the model id, which a few features persist).

export type Provider = "anthropic" | "openai" | "google" | "openrouter";

/** Native providers with a curated (standard, cheap) model pair. OpenRouter is
 *  excluded — the user names a single model used for both tiers. */
export type NativeProvider = Exclude<Provider, "openrouter">;

export type Tier = "standard" | "cheap";

export type LlmMessage = { role: "user" | "assistant"; content: string };

export type CompleteArgs = {
  system: string;
  messages: LlmMessage[];
  maxTokens: number;
  tier: Tier; // adapter resolves tier → concrete model id
};

export type CompleteResult = {
  /** The model's text output (the single text block). */
  text: string;
  /** The concrete model id that produced it (persisted by some features). */
  model: string;
};

export interface LlmClient {
  readonly provider: Provider;
  complete(args: CompleteArgs): Promise<CompleteResult>;
}
```

- [ ] **Step 2: Write `models.ts`**

```ts
// src/lib/llm/models.ts
// Curated (standard, cheap) model pair per native provider. Kept dependency-free
// so adapters and their tests can import without pulling in the DB client.
// OpenRouter has no entry — the user supplies one model id, used for both tiers.
import type { NativeProvider, Tier } from "./types";

export const PROVIDER_MODELS: Record<NativeProvider, Record<Tier, string>> = {
  anthropic: { standard: "claude-sonnet-4-6", cheap: "claude-haiku-4-5-20251001" },
  openai: { standard: "gpt-5", cheap: "gpt-5-mini" },
  google: { standard: "gemini-2.5-pro", cheap: "gemini-2.5-flash" },
};

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
```

- [ ] **Step 3: Write `errors.ts`**

```ts
// src/lib/llm/errors.ts
/** Thrown when the user has no usable AI provider configured. Replaces the old
 *  Anthropic-specific NoUserApiKeyError. Callers map it to a 400/inline error. */
export class NoLlmKeyError extends Error {
  constructor() {
    super("No AI provider configured. Add a key in Settings → API Keys.");
    this.name = "NoLlmKeyError";
  }
}
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/llm/types.ts src/lib/llm/models.ts src/lib/llm/errors.ts
git commit -m "feat(llm): provider-agnostic LlmClient types, model table, error"
```

---

## Task 3: Anthropic adapter

**Files:**
- Create: `src/lib/llm/adapters/anthropic.ts`
- Test: `src/lib/llm/adapters/anthropic.test.ts`

Design: the adapter wraps an already-constructed SDK client (the factory builds the real one; tests inject a fake — same DI pattern as `event-diff.test.ts`).

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/llm/adapters/anthropic.test.ts
import { describe, it, expect } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { anthropicAdapter } from "./anthropic";
import { PROVIDER_MODELS } from "../models";

function fake(text: string) {
  const calls: any[] = [];
  const client = {
    messages: {
      create: async (args: any) => {
        calls.push(args);
        return { model: "claude-from-api", content: [{ type: "text", text }] };
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

describe("anthropicAdapter", () => {
  it("maps tier → model, returns text + model", async () => {
    const { client, calls } = fake("hello");
    const c = anthropicAdapter(client);
    const res = await c.complete({
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 42,
      tier: "standard",
    });
    expect(res).toEqual({ text: "hello", model: "claude-from-api" });
    expect(c.provider).toBe("anthropic");
    expect(calls[0].model).toBe(PROVIDER_MODELS.anthropic.standard);
    expect(calls[0].max_tokens).toBe(42);
    expect(calls[0].system).toBe("sys");
  });

  it("uses the cheap model id for tier=cheap", async () => {
    const { client, calls } = fake("x");
    await anthropicAdapter(client).complete({
      system: "s", messages: [{ role: "user", content: "u" }], maxTokens: 10, tier: "cheap",
    });
    expect(calls[0].model).toBe(PROVIDER_MODELS.anthropic.cheap);
  });

  it("throws when no text block is returned", async () => {
    const client = {
      messages: { create: async () => ({ model: "m", content: [{ type: "tool_use" }] }) },
    } as unknown as Anthropic;
    await expect(
      anthropicAdapter(client).complete({ system: "s", messages: [], maxTokens: 1, tier: "standard" }),
    ).rejects.toThrow(/no text/i);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run src/lib/llm/adapters/anthropic.test.ts`
Expected: FAIL — cannot find `./anthropic`.

- [ ] **Step 3: Write the adapter**

```ts
// src/lib/llm/adapters/anthropic.ts
import type Anthropic from "@anthropic-ai/sdk";
import type { LlmClient } from "../types";
import { PROVIDER_MODELS } from "../models";

/** Wrap a constructed Anthropic SDK client as an LlmClient. */
export function anthropicAdapter(client: Anthropic): LlmClient {
  return {
    provider: "anthropic",
    async complete({ system, messages, maxTokens, tier }) {
      const model = PROVIDER_MODELS.anthropic[tier];
      const res = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system,
        messages,
      });
      const block = res.content.find((b) => b.type === "text");
      if (!block || block.type !== "text") {
        throw new Error("anthropic: no text content returned");
      }
      return { text: block.text, model: res.model };
    },
  };
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run src/lib/llm/adapters/anthropic.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/llm/adapters/anthropic.ts src/lib/llm/adapters/anthropic.test.ts
git commit -m "feat(llm): anthropic adapter"
```

---

## Task 4: OpenAI adapter

**Files:**
- Create: `src/lib/llm/adapters/openai.ts`
- Test: `src/lib/llm/adapters/openai.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/llm/adapters/openai.test.ts
import { describe, it, expect } from "vitest";
import type OpenAI from "openai";
import { openaiAdapter } from "./openai";
import { PROVIDER_MODELS } from "../models";

function fake(content: string | null) {
  const calls: any[] = [];
  const client = {
    chat: {
      completions: {
        create: async (args: any) => {
          calls.push(args);
          return { model: "gpt-from-api", choices: [{ message: { content } }] };
        },
      },
    },
  } as unknown as OpenAI;
  return { client, calls };
}

describe("openaiAdapter", () => {
  it("prepends the system message and returns text + model", async () => {
    const { client, calls } = fake("hello");
    const c = openaiAdapter(client);
    const res = await c.complete({
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 42,
      tier: "standard",
    });
    expect(res).toEqual({ text: "hello", model: "gpt-from-api" });
    expect(c.provider).toBe("openai");
    expect(calls[0].model).toBe(PROVIDER_MODELS.openai.standard);
    expect(calls[0].max_completion_tokens).toBe(42);
    expect(calls[0].messages[0]).toEqual({ role: "system", content: "sys" });
    expect(calls[0].messages[1]).toEqual({ role: "user", content: "hi" });
  });

  it("throws when the model returns empty content", async () => {
    const { client } = fake(null);
    await expect(
      openaiAdapter(client).complete({ system: "s", messages: [], maxTokens: 1, tier: "cheap" }),
    ).rejects.toThrow(/no text/i);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run src/lib/llm/adapters/openai.test.ts`
Expected: FAIL — cannot find `./openai`.

- [ ] **Step 3: Write the adapter**

```ts
// src/lib/llm/adapters/openai.ts
import type OpenAI from "openai";
import type { LlmClient } from "../types";
import { PROVIDER_MODELS } from "../models";

/** Wrap a constructed OpenAI SDK client as an LlmClient (Chat Completions). */
export function openaiAdapter(client: OpenAI): LlmClient {
  return {
    provider: "openai",
    async complete({ system, messages, maxTokens, tier }) {
      const model = PROVIDER_MODELS.openai[tier];
      const res = await client.chat.completions.create({
        model,
        max_completion_tokens: maxTokens,
        messages: [{ role: "system", content: system }, ...messages],
      });
      const text = res.choices[0]?.message?.content;
      if (!text) throw new Error("openai: no text content returned");
      return { text, model: res.model };
    },
  };
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run src/lib/llm/adapters/openai.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/llm/adapters/openai.ts src/lib/llm/adapters/openai.test.ts
git commit -m "feat(llm): openai adapter"
```

---

## Task 5: OpenRouter adapter

**Files:**
- Create: `src/lib/llm/adapters/openrouter.ts`
- Test: `src/lib/llm/adapters/openrouter.test.ts`

Reuses the `openai` SDK (constructed with the OpenRouter base URL by the factory). Uses the user's single chosen `model` for both tiers, and `max_tokens` (OpenRouter's OpenAI-compatible param).

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/llm/adapters/openrouter.test.ts
import { describe, it, expect } from "vitest";
import type OpenAI from "openai";
import { openrouterAdapter } from "./openrouter";

function fake(content: string | null) {
  const calls: any[] = [];
  const client = {
    chat: {
      completions: {
        create: async (args: any) => {
          calls.push(args);
          return { model: args.model, choices: [{ message: { content } }] };
        },
      },
    },
  } as unknown as OpenAI;
  return { client, calls };
}

describe("openrouterAdapter", () => {
  it("uses the configured model for every tier and max_tokens", async () => {
    const { client, calls } = fake("hi");
    const c = openrouterAdapter(client, "meta-llama/llama-3.3-70b-instruct");
    const res = await c.complete({
      system: "s", messages: [{ role: "user", content: "u" }], maxTokens: 7, tier: "cheap",
    });
    expect(res).toEqual({ text: "hi", model: "meta-llama/llama-3.3-70b-instruct" });
    expect(c.provider).toBe("openrouter");
    expect(calls[0].model).toBe("meta-llama/llama-3.3-70b-instruct");
    expect(calls[0].max_tokens).toBe(7);
    expect(calls[0].messages[0]).toEqual({ role: "system", content: "s" });
  });

  it("throws on empty content", async () => {
    const { client } = fake(null);
    await expect(
      openrouterAdapter(client, "x/y").complete({ system: "s", messages: [], maxTokens: 1, tier: "standard" }),
    ).rejects.toThrow(/no text/i);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run src/lib/llm/adapters/openrouter.test.ts`
Expected: FAIL — cannot find `./openrouter`.

- [ ] **Step 3: Write the adapter**

```ts
// src/lib/llm/adapters/openrouter.ts
import type OpenAI from "openai";
import type { LlmClient } from "../types";

/** Wrap an OpenAI SDK client pointed at OpenRouter. The user's single chosen
 *  model id is used for both tiers (OpenRouter is an aggregator). */
export function openrouterAdapter(client: OpenAI, model: string): LlmClient {
  return {
    provider: "openrouter",
    async complete({ system, messages, maxTokens }) {
      const res = await client.chat.completions.create({
        model,
        max_tokens: maxTokens,
        messages: [{ role: "system", content: system }, ...messages],
      });
      const text = res.choices[0]?.message?.content;
      if (!text) throw new Error("openrouter: no text content returned");
      return { text, model: res.model ?? model };
    },
  };
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run src/lib/llm/adapters/openrouter.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/llm/adapters/openrouter.ts src/lib/llm/adapters/openrouter.test.ts
git commit -m "feat(llm): openrouter adapter (openai SDK + base URL)"
```

---

## Task 6: Google adapter

**Files:**
- Create: `src/lib/llm/adapters/google.ts`
- Test: `src/lib/llm/adapters/google.test.ts`

Google's API differs: `models.generateContent({ model, contents, config: { systemInstruction, maxOutputTokens } })`, response `.text`. Map `messages` → `contents` with role `"user"`/`"model"` (Google uses `model`, not `assistant`). Since the response does not reliably echo the model id, return the resolved id we sent.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/llm/adapters/google.test.ts
import { describe, it, expect } from "vitest";
import type { GoogleGenAI } from "@google/genai";
import { googleAdapter } from "./google";
import { PROVIDER_MODELS } from "../models";

function fake(text: string) {
  const calls: any[] = [];
  const client = {
    models: {
      generateContent: async (args: any) => {
        calls.push(args);
        return { text };
      },
    },
  } as unknown as GoogleGenAI;
  return { client, calls };
}

describe("googleAdapter", () => {
  it("maps system→systemInstruction, messages→contents, returns text + resolved model", async () => {
    const { client, calls } = fake("hello");
    const c = googleAdapter(client);
    const res = await c.complete({
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 42,
      tier: "standard",
    });
    expect(res).toEqual({ text: "hello", model: PROVIDER_MODELS.google.standard });
    expect(c.provider).toBe("google");
    expect(calls[0].model).toBe(PROVIDER_MODELS.google.standard);
    expect(calls[0].config.systemInstruction).toBe("sys");
    expect(calls[0].config.maxOutputTokens).toBe(42);
    expect(calls[0].contents[0]).toEqual({ role: "user", parts: [{ text: "hi" }] });
  });

  it("throws on empty text", async () => {
    const { client } = fake("");
    await expect(
      googleAdapter(client).complete({ system: "s", messages: [], maxTokens: 1, tier: "cheap" }),
    ).rejects.toThrow(/no text/i);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run src/lib/llm/adapters/google.test.ts`
Expected: FAIL — cannot find `./google`.

- [ ] **Step 3: Write the adapter**

```ts
// src/lib/llm/adapters/google.ts
import type { GoogleGenAI } from "@google/genai";
import type { LlmClient } from "../types";
import { PROVIDER_MODELS } from "../models";

/** Wrap a constructed @google/genai client as an LlmClient. */
export function googleAdapter(client: GoogleGenAI): LlmClient {
  return {
    provider: "google",
    async complete({ system, messages, maxTokens, tier }) {
      const model = PROVIDER_MODELS.google[tier];
      const res = await client.models.generateContent({
        model,
        contents: messages.map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }],
        })),
        config: { systemInstruction: system, maxOutputTokens: maxTokens },
      });
      const text = res.text;
      if (!text) throw new Error("google: no text content returned");
      return { text, model };
    },
  };
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run src/lib/llm/adapters/google.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/llm/adapters/google.ts src/lib/llm/adapters/google.test.ts
git commit -m "feat(llm): google (gemini) adapter"
```

---

## Task 7: Prisma schema + data-preserving migration

**Files:**
- Modify: `prisma/schema.prisma` (User model lines 15–33, UserApiKey model lines 35–44)
- Create: `prisma/migrations/<timestamp>_multi_provider_byok/migration.sql` (generated, then hand-edited)
- Regenerate: `src/generated/prisma/**`

- [ ] **Step 1: Edit the `User` model** — replace the `apiKey UserApiKey?` relation and add the active pointer.

In `prisma/schema.prisma`, change (within `model User`):
```prisma
  apiKey       UserApiKey?
  apiTokens    ApiToken[]
```
to:
```prisma
  providerKeys ProviderKey[]
  apiTokens    ApiToken[]
```
and add this field above the relations block (next to `alertConfigJson`):
```prisma
  // Which AI provider the user's features run against. Null = none configured.
  activeAiProvider String?
```

- [ ] **Step 2: Replace the `UserApiKey` model with `ProviderKey`**

Replace the whole `UserApiKey` block (the comment + model, schema lines 35–44) with:
```prisma
// Bring-your-own-key: a user may store one key per LLM provider and switch the
// active one (User.activeAiProvider) without re-pasting. Keys are encrypted at
// rest with ENCRYPTION_KEY. `model` is set only for OpenRouter (user-chosen).
model ProviderKey {
  userId    String
  provider  String // "anthropic" | "openai" | "google" | "openrouter"
  keyEnc    String // encrypted with ENCRYPTION_KEY
  model     String? // OpenRouter only
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@id([userId, provider])
}
```

- [ ] **Step 3: Generate the migration WITHOUT applying**

Run: `npx prisma migrate dev --create-only --name multi_provider_byok`
Expected: a new folder under `prisma/migrations/` with a `migration.sql`. It will (in some order) create `ProviderKey`, add `User.activeAiProvider`, and `DROP TABLE "UserApiKey"` — **data-lossy as generated.**

- [ ] **Step 4: Hand-edit `migration.sql` to preserve data**

Open the generated `migration.sql` and reorder/insert so the final file reads in this order (table/column names must match what Prisma generated — adjust quoting only if different):

```sql
-- 1. New column on User
ALTER TABLE "User" ADD COLUMN "activeAiProvider" TEXT;

-- 2. New ProviderKey table
CREATE TABLE "ProviderKey" (
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "keyEnc" TEXT NOT NULL,
    "model" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ProviderKey_pkey" PRIMARY KEY ("userId", "provider")
);
ALTER TABLE "ProviderKey" ADD CONSTRAINT "ProviderKey_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 3. Migrate existing Anthropic keys into the new shape (BEFORE dropping the old table)
INSERT INTO "ProviderKey" ("userId", "provider", "keyEnc", "model", "createdAt", "updatedAt")
SELECT "userId", 'anthropic', "anthropicKeyEnc", NULL, "createdAt", "updatedAt"
FROM "UserApiKey";

UPDATE "User"
SET "activeAiProvider" = 'anthropic'
WHERE "id" IN (SELECT "userId" FROM "UserApiKey");

-- 4. Drop the old table
DROP TABLE "UserApiKey";
```

- [ ] **Step 5: Apply the migration + regenerate the client**

Run: `npx prisma migrate dev`
Expected: migration applies cleanly against the local dev DB; `prisma generate` runs; `src/generated/prisma/**` updates (no more `UserApiKey`, new `ProviderKey`).

- [ ] **Step 6: Typecheck (expect failures — they map the remaining work)**

Run: `npx tsc --noEmit`
Expected: errors only in files that still reference `prisma.userApiKey` / `UserApiKey` (the Settings page + `src/lib/anthropic.ts`). These are fixed in Tasks 8–12. Note them; do not fix yet.

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/generated/prisma
git commit -m "feat(db): ProviderKey table + User.activeAiProvider, migrate Anthropic keys"
```

---

## Task 8: The factory — `buildLlmClient` + `llmFor`

**Files:**
- Create: `src/lib/llm/index.ts`
- Test: `src/lib/llm/index.test.ts`
- Delete: `src/lib/anthropic.ts` (replaced)

`buildLlmClient` is a pure function (constructs an SDK client + adapter from a config) — unit-testable with no DB or network. `llmFor` does the DB lookup then delegates.

- [ ] **Step 1: Write the failing test for `buildLlmClient`**

```ts
// src/lib/llm/index.test.ts
import { describe, it, expect } from "vitest";
import { buildLlmClient } from "./index";
import { NoLlmKeyError } from "./errors";

describe("buildLlmClient", () => {
  it("builds a client per provider with the right provider tag", () => {
    expect(buildLlmClient({ provider: "anthropic", apiKey: "sk-ant-x" }).provider).toBe("anthropic");
    expect(buildLlmClient({ provider: "openai", apiKey: "sk-x" }).provider).toBe("openai");
    expect(buildLlmClient({ provider: "google", apiKey: "AIzax" }).provider).toBe("google");
    expect(
      buildLlmClient({ provider: "openrouter", apiKey: "sk-or-x", model: "x/y" }).provider,
    ).toBe("openrouter");
  });

  it("throws NoLlmKeyError when OpenRouter has no model", () => {
    expect(() => buildLlmClient({ provider: "openrouter", apiKey: "sk-or-x", model: null })).toThrow(
      NoLlmKeyError,
    );
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run src/lib/llm/index.test.ts`
Expected: FAIL — cannot find `./index` export `buildLlmClient`.

- [ ] **Step 3: Write `index.ts`**

```ts
// src/lib/llm/index.ts
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";

import { prisma } from "@/lib/prisma";
import { decrypt } from "@/lib/crypto";

import type { LlmClient, Provider } from "./types";
import { NoLlmKeyError } from "./errors";
import { OPENROUTER_BASE_URL } from "./models";
import { anthropicAdapter } from "./adapters/anthropic";
import { openaiAdapter } from "./adapters/openai";
import { openrouterAdapter } from "./adapters/openrouter";
import { googleAdapter } from "./adapters/google";

export type { LlmClient, Provider, Tier } from "./types";
export { NoLlmKeyError } from "./errors";
export { PROVIDER_MODELS } from "./models";

export type LlmConfig = {
  provider: Provider;
  apiKey: string;
  model?: string | null; // OpenRouter only
};

/** Pure: construct the SDK client + adapter for a provider config. No DB. */
export function buildLlmClient(cfg: LlmConfig): LlmClient {
  switch (cfg.provider) {
    case "anthropic":
      return anthropicAdapter(new Anthropic({ apiKey: cfg.apiKey }));
    case "openai":
      return openaiAdapter(new OpenAI({ apiKey: cfg.apiKey }));
    case "openrouter":
      if (!cfg.model) throw new NoLlmKeyError();
      return openrouterAdapter(
        new OpenAI({ apiKey: cfg.apiKey, baseURL: OPENROUTER_BASE_URL }),
        cfg.model,
      );
    case "google":
      return googleAdapter(new GoogleGenAI({ apiKey: cfg.apiKey }));
    default:
      throw new NoLlmKeyError();
  }
}

/**
 * Build an LlmClient for a user's active provider (bring-your-own-key).
 * Throws NoLlmKeyError if no provider is active or its key is unusable.
 */
export async function llmFor(userId: string): Promise<LlmClient> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { activeAiProvider: true },
  });
  const provider = user?.activeAiProvider as Provider | null | undefined;
  if (!provider) throw new NoLlmKeyError();

  const row = await prisma.providerKey.findUnique({
    where: { userId_provider: { userId, provider } },
  });
  if (!row) throw new NoLlmKeyError();

  let apiKey: string;
  try {
    apiKey = decrypt(row.keyEnc);
  } catch {
    throw new NoLlmKeyError();
  }
  return buildLlmClient({ provider, apiKey, model: row.model });
}
```

- [ ] **Step 4: Delete the old wrapper**

Run: `git rm src/lib/anthropic.ts`
Expected: file removed. (Its consumers are migrated in Tasks 9–11.)

- [ ] **Step 5: Run test, verify it passes**

Run: `npx vitest run src/lib/llm/index.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/lib/llm/index.ts src/lib/llm/index.test.ts
git commit -m "feat(llm): buildLlmClient + llmFor factory; remove anthropic wrapper"
```

---

## Task 9: Refactor self-serve modules (rule-compiler, transform, diagnose, digest, drift)

These five build their own client via `anthropicFor` and have no unit tests, so this is a mechanical edit verified by `tsc`. Each: swap the import, swap the client call, swap `messages.create(...)`+text-extraction for `llm.complete(...)`.

**Files:** `src/lib/ai/rule-compiler.ts`, `src/lib/ai/transform.ts`, `src/lib/ai/diagnose.ts`, `src/lib/ai/digest.ts`, `src/lib/ai/drift.ts`

- [ ] **Step 1: rule-compiler.ts**

Change the import (line 1):
```ts
import { llmFor } from "@/lib/llm";
```
Change line 56:
```ts
  const llm = await llmFor(userId);
```
Replace the `messages.create`+extraction block (lines 69–80) with:
```ts
  const { text } = await llm.complete({
    tier: "standard",
    maxTokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });
  const raw = extractJsonText(text);
```

- [ ] **Step 2: transform.ts**

Change import (line 1):
```ts
import { llmFor } from "@/lib/llm";
```
Change line 41:
```ts
  const llm = await llmFor(userId);
```
Replace `messages.create`+extraction (lines 54–65) with:
```ts
  const { text } = await llm.complete({
    tier: "standard",
    maxTokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });
  let codeJs = text.trim();
```

- [ ] **Step 3: diagnose.ts**

Change import (line 1):
```ts
import { llmFor } from "@/lib/llm";
```
Change line 48:
```ts
  const llm = await llmFor(userId);
```
Replace `messages.create`+extraction (lines 76–87) with:
```ts
  const { text, model } = await llm.complete({
    tier: "standard",
    maxTokens: 800,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });
  const raw = text.trim();
```
And change the return (line 92) to use the real model id:
```ts
  return { summary, detail, modelUsed: model };
```

- [ ] **Step 4: digest.ts**

Change import (line 1):
```ts
import { llmFor } from "@/lib/llm";
```
Change line 114:
```ts
  const llm = await llmFor(userId);
```
Replace `messages.create`+extraction (lines 116–136) with:
```ts
  const { text } = await llm.complete({
    tier: "cheap",
    maxTokens: 700,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          `Weekly stats:`,
          "```json",
          JSON.stringify(stats, null, 2),
          "```",
          ``,
          `Write the digest body.`,
        ].join("\n"),
      },
    ],
  });
  return text.trim();
```

- [ ] **Step 5: drift.ts**

Change import (line 1):
```ts
import { llmFor } from "@/lib/llm";
```
Change line 36:
```ts
  const llm = await llmFor(userId);
```
Replace `messages.create`+extraction (lines 37–62) with:
```ts
  const { text } = await llm.complete({
    tier: "cheap",
    maxTokens: 512,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          `Previous fingerprint:`,
          "```json",
          JSON.stringify(previous, null, 2).slice(0, 4000),
          "```",
          ``,
          `Current fingerprint:`,
          "```json",
          JSON.stringify(current, null, 2).slice(0, 4000),
          "```",
        ].join("\n"),
      },
    ],
  });
  let raw = text.trim();
```

- [ ] **Step 6: Typecheck the five modules**

Run: `npx tsc --noEmit`
Expected: no errors in these five files (errors may remain in the injected modules + call sites — Tasks 10–11).

- [ ] **Step 7: Commit**

```bash
git add src/lib/ai/rule-compiler.ts src/lib/ai/transform.ts src/lib/ai/diagnose.ts src/lib/ai/digest.ts src/lib/ai/drift.ts
git commit -m "refactor(ai): self-serve modules use llmFor/complete"
```

---

## Task 10: Refactor injected-client modules + their tests (search-compiler, fixtures, event-diff)

Each takes an injected client. Change the param from `anthropic: Anthropic` to `llm: LlmClient`, swap the call, and simplify the tests' fake from a fake Anthropic to a fake `LlmClient`.

**Files:** `src/lib/ai/search-compiler.ts`, `src/lib/ai/fixtures.ts`, `src/lib/ai/event-diff.ts` + their `.test.ts`

- [ ] **Step 1: Update `search-compiler.ts`**

Replace imports (lines 1–4):
```ts
import type { LlmClient } from "@/lib/llm";
import { extractJsonText } from "./json";
```
(Remove the `Anthropic` and `MODEL_DEFAULT` imports.)
Change the `CompileSearchArgs.anthropic` field (line 49):
```ts
  llm: LlmClient;
```
Replace `messages.create`+extraction (lines 80–90) with:
```ts
  const { text } = await args.llm.complete({
    tier: "standard",
    maxTokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonText(text));
  } catch {
    throw new SearchCompileError("could not interpret the search: model did not return JSON");
  }
```

- [ ] **Step 2: Update `search-compiler.test.ts`** — replace the fake Anthropic client with a fake `LlmClient`.

Read the file first. Replace its `fakeClient`/`anthropic:` usage so calls pass `llm:` and the fake returns `{ text, model }`:
```ts
import type { LlmClient } from "@/lib/llm";

function fakeLlm(text: string): LlmClient {
  return {
    provider: "anthropic",
    complete: async () => ({ text, model: "test-model" }),
  };
}
```
Update each `compileSearchQuery({ anthropic: ..., ... })` call to `compileSearchQuery({ llm: fakeLlm(JSON_STR), ... })`. Keep all assertions on the compiled query unchanged.

- [ ] **Step 3: Update `fixtures.ts`**

Replace imports (lines 1–4):
```ts
import type { LlmClient } from "@/lib/llm";
import { extractJsonText } from "./json";
```
Change `GenerateFixtureOpts.anthropic` (line 34):
```ts
  llm: LlmClient;
```
Change the destructure (line 46):
```ts
  const { llm, prompt, sampleBodies, verifyStyle } = opts;
```
Replace `messages.create`+extraction (lines 69–81) with:
```ts
  const { text, model } = await llm.complete({
    tier: "standard",
    maxTokens: 2048,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: parts.join("\n") }],
  });

  const raw = extractJsonText(text);
```
Change the return's `model` (line 91):
```ts
    model,
```

- [ ] **Step 4: Update `fixtures.test.ts`** — same fake swap.

Read the file. Replace the fake Anthropic with `fakeLlm` (as in Step 2), change `generateFixture({ anthropic: ..., ... })` to `{ llm: fakeLlm(...), ... }`, and update any assertion on the sent request to read the captured `complete` args instead of `messages.create` args. Keep behavioral assertions (valid JSON, error on bad output, grounding) unchanged.

- [ ] **Step 5: Update `event-diff.ts`**

Replace imports (lines 1–4):
```ts
import type { LlmClient } from "@/lib/llm";
import { extractJsonText } from "./json";
```
(Remove `Anthropic` and `MODEL_CHEAP`.)
Change `ExplainEventDiffOpts.anthropic` (line 57):
```ts
  llm: LlmClient;
```
Change the destructure (line 77):
```ts
  const { llm, bodyA, bodyB } = opts;
```
Replace `messages.create`+extraction (lines 93–105) with:
```ts
  const { text, model } = await llm.complete({
    tier: "cheap",
    maxTokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content }],
  });

  const raw = extractJsonText(text);
```
Change the return's `modelUsed` (line 150):
```ts
    modelUsed: model,
```

- [ ] **Step 6: Update `event-diff.test.ts`** — replace `fakeClient` with a fake `LlmClient`.

Replace the `fakeClient` helper (lines 7–18) with:
```ts
import type { LlmClient } from "@/lib/llm";

function fakeClient(text: string) {
  const calls: Array<{ system: string; messages: unknown }> = [];
  const client: LlmClient = {
    provider: "anthropic",
    complete: async (args) => {
      calls.push({ system: args.system, messages: args.messages });
      return { text, model: "model-from-api" };
    },
  };
  return { client, calls };
}
```
Change each `explainEventDiff({ anthropic: client, ... })` to `explainEventDiff({ llm: client, ... })`. The "caps each body" test reads `calls[0].messages` — unchanged. All assertions (including `modelUsed` === "model-from-api") stay.

- [ ] **Step 7: Run the three module test files**

Run: `npx vitest run src/lib/ai/event-diff.test.ts src/lib/ai/fixtures.test.ts src/lib/ai/search-compiler.test.ts`
Expected: PASS (all existing assertions green against the new `llm` param).

- [ ] **Step 8: Commit**

```bash
git add src/lib/ai/search-compiler.ts src/lib/ai/search-compiler.test.ts src/lib/ai/fixtures.ts src/lib/ai/fixtures.test.ts src/lib/ai/event-diff.ts src/lib/ai/event-diff.test.ts
git commit -m "refactor(ai): injected modules take LlmClient; simplify fakes"
```

---

## Task 11: Update call sites + error catch-sites

**Files:** `src/app/api/v1/fixtures/route.ts`, `src/lib/services/search.ts`, `src/lib/actions/event-diff.ts`, `src/app/api/v1/events/search/route.ts`, `src/lib/actions/search.ts`, `src/lib/mcp/server.ts`

- [ ] **Step 1: `fixtures` route** — build the client via `llmFor`, map `NoLlmKeyError` → 400.

Replace imports (lines 3, 7):
```ts
import { llmFor, NoLlmKeyError } from "@/lib/llm";
```
(Remove `import Anthropic from "@anthropic-ai/sdk"` and `getUserApiKey`.)
Replace the key check (lines 26–32) with a client build that defers the error to the catch:
```ts
  let llm;
  try {
    llm = await llmFor(auth.userId);
  } catch (err) {
    if (err instanceof NoLlmKeyError) {
      return apiError("validation_error", err.message);
    }
    throw err;
  }
```
Change the `generateFixture` call (line 43):
```ts
      llm,
```

- [ ] **Step 2: `services/search.ts`** — swap `anthropicFor` → `llmFor`.

Change import (line 2):
```ts
import { llmFor } from "@/lib/llm";
```
Change the doc comment (line 33) `NoUserApiKeyError` → `NoLlmKeyError`. Change the parallel load (lines 39–44):
```ts
  const [llm, ctx] = await Promise.all([
    llmFor(userId),
    loadSearchContext(userId),
  ]);
  return compileSearchQuery({
    llm,
```

- [ ] **Step 3: `actions/event-diff.ts`** — swap `anthropicFor` → `llmFor`.

Change import (line 7):
```ts
import { llmFor } from "@/lib/llm";
```
Change lines 60–62:
```ts
  const llm = await llmFor(userId);
  const result: DiffResult = await explainEventDiff({
    llm,
```

- [ ] **Step 4: `events/search` route** — new error type + message.

Change import (line 5):
```ts
import { NoLlmKeyError } from "@/lib/llm";
```
Change the catch (lines 40–41):
```ts
    if (err instanceof NoLlmKeyError) {
      return apiError("validation_error", "No AI provider configured (add a key in Settings → API Keys).");
    }
```

- [ ] **Step 5: `actions/search.ts`** — new error type + message.

Change import (line 4):
```ts
import { NoLlmKeyError } from "@/lib/llm";
```
Change the catch (lines 29–30):
```ts
    if (e instanceof NoLlmKeyError) {
      return { ok: false, error: "No AI provider configured. Add a key in Settings → API Keys." };
    }
```

- [ ] **Step 6: `mcp/server.ts`** — match the new error instead of the old message regex.

Read lines around 40–50. The current line 46 tests `/No Anthropic API key configured/i.test(err.message)`. Replace that condition to also catch the new message — change the regex to `/No AI provider configured/i`. (If the surrounding code can import `NoLlmKeyError`, prefer `err instanceof NoLlmKeyError`; otherwise the message regex is fine since `NoLlmKeyError.message` is stable.)

```ts
    if (/No AI provider configured/i.test(err.message)) return toolError(err.message);
```

- [ ] **Step 7: Additional `prisma.userApiKey` sites discovered during Task 7** (plan gap — the original planning grep was case-sensitive and missed these `prisma.userApiKey` / `User.apiKey`-relation usages).

The 4 dashboard pages each compute a UI-gating boolean:
```ts
const hasApiKey = !!(await prisma.userApiKey.findUnique({ where: { userId: <X> }, select: { ... } }));
```
In each, replace the `prisma.userApiKey.findUnique({...})` call with the new model (keep the same `userId` value `<X>` and the surrounding `!!(...)`):
```ts
const hasApiKey = !!(await prisma.providerKey.findFirst({ where: { userId: <X> }, select: { provider: true } }));
```
Files:
- `src/app/(dashboard)/events/[id]/page.tsx` (line ~65)
- `src/app/(dashboard)/events/compare/page.tsx` (line ~41)
- `src/app/(dashboard)/routes/[id]/filter/page.tsx` (line ~30)
- `src/app/(dashboard)/routes/[id]/transform/page.tsx` (line ~31)

The `hasApiKey: boolean` props on `filter-editor.tsx`, `diagnose-button.tsx`, `transform-editor.tsx`, `explain-diff-button.tsx` are unchanged — they still receive the boolean.

`src/scripts/digest.ts` (line ~18) — the cron queries users who have AI configured. Replace:
```ts
    where: { apiKey: { isNot: null } },
```
with (a user is "configured" when they have an active provider, matching `llmFor`):
```ts
    where: { activeAiProvider: { not: null } },
```

`src/lib/services/account.test.ts` — update the two `prisma.userApiKey` references:
- line ~59 (create): `prisma.userApiKey.create({ data: { userId: user.id, anthropicKeyEnc: "KEY-ciphertext" } })` → `prisma.providerKey.create({ data: { userId: user.id, provider: "anthropic", keyEnc: "KEY-ciphertext" } })`
- line ~103 (assert deleted): `prisma.userApiKey.findUnique({ where: { userId: a.user.id } })` → `prisma.providerKey.findFirst({ where: { userId: a.user.id } })`

- [ ] **Step 8: Full typecheck — should be clean now**

Run: `npx tsc --noEmit`
Expected: exit 0 (all `anthropicFor`/`getUserApiKey`/`UserApiKey`/`userApiKey` references gone except the Settings page + `actions/api-keys.ts`, fixed in Task 12).
> If `settings/api-keys/page.tsx` or `lib/actions/api-keys.ts` still error on `prisma.userApiKey`, that's expected — Task 12 rewrites them.

- [ ] **Step 9: Commit**

```bash
git add src/app/api/v1/fixtures/route.ts src/lib/services/search.ts src/lib/actions/event-diff.ts src/app/api/v1/events/search/route.ts src/lib/actions/search.ts src/lib/mcp/server.ts "src/app/(dashboard)/events/[id]/page.tsx" "src/app/(dashboard)/events/compare/page.tsx" "src/app/(dashboard)/routes/[id]/filter/page.tsx" "src/app/(dashboard)/routes/[id]/transform/page.tsx" src/scripts/digest.ts src/lib/services/account.test.ts
git commit -m "refactor: call sites + error handling use llmFor/NoLlmKeyError"
```

---

## Task 12: Settings — multi-provider key management

**Files:**
- Rewrite: `src/lib/actions/api-keys.ts`
- Test: `src/lib/actions/api-keys.test.ts` (new)
- Rewrite: `src/app/(dashboard)/settings/api-keys/page.tsx`

Validation rules (soft, helpful errors — not security): provider must be one of the four; key prefix `sk-ant-` (anthropic) / `sk-or-` (openrouter) / `sk-` (openai) / `AIza` (google); OpenRouter requires a non-empty `model`. Check OpenRouter's `sk-or-` before OpenAI's `sk-` (the former is a prefix-superset).

- [ ] **Step 1: Write the validation helper test**

```ts
// src/lib/actions/api-keys.test.ts
import { describe, it, expect } from "vitest";
import { validateProviderKey } from "./api-keys";

describe("validateProviderKey", () => {
  it("accepts well-formed keys per provider", () => {
    expect(validateProviderKey("anthropic", "sk-ant-abc", null)).toEqual({ ok: true });
    expect(validateProviderKey("openai", "sk-abc", null)).toEqual({ ok: true });
    expect(validateProviderKey("google", "AIzaABC", null)).toEqual({ ok: true });
    expect(validateProviderKey("openrouter", "sk-or-abc", "meta/llama")).toEqual({ ok: true });
  });

  it("rejects an unknown provider", () => {
    expect(validateProviderKey("grok", "x", null).ok).toBe(false);
  });

  it("rejects a wrong prefix", () => {
    expect(validateProviderKey("anthropic", "sk-abc", null).ok).toBe(false);
    expect(validateProviderKey("openai", "ghp_abc", null).ok).toBe(false);
  });

  it("requires a model for OpenRouter", () => {
    expect(validateProviderKey("openrouter", "sk-or-abc", "").ok).toBe(false);
    expect(validateProviderKey("openrouter", "sk-or-abc", null).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run src/lib/actions/api-keys.test.ts`
Expected: FAIL — `validateProviderKey` not exported.

- [ ] **Step 3: Rewrite `api-keys.ts`**

```ts
// src/lib/actions/api-keys.ts
"use server";

import { revalidatePath } from "next/cache";

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { encrypt } from "@/lib/crypto";
import type { Provider } from "@/lib/llm";

const PROVIDERS: Provider[] = ["anthropic", "openai", "google", "openrouter"];

// Order matters: openrouter's "sk-or-" is a superset of openai's "sk-".
const PREFIX: Record<Provider, string> = {
  anthropic: "sk-ant-",
  openrouter: "sk-or-",
  openai: "sk-",
  google: "AIza",
};

export function validateProviderKey(
  provider: string,
  key: string,
  model: string | null,
): { ok: true } | { ok: false; error: string } {
  if (!PROVIDERS.includes(provider as Provider)) {
    return { ok: false, error: "Unknown provider." };
  }
  const p = provider as Provider;
  if (!key.startsWith(PREFIX[p])) {
    return { ok: false, error: `That doesn't look like a ${p} key (expected ${PREFIX[p]}…).` };
  }
  if (p === "openrouter" && !model?.trim()) {
    return { ok: false, error: "OpenRouter requires a model id (e.g. meta-llama/llama-3.3-70b-instruct)." };
  }
  return { ok: true };
}

async function requireUserId(): Promise<string> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("unauthorized");
  return session.user.id;
}

export async function saveProviderKey(formData: FormData) {
  const userId = await requireUserId();
  const provider = String(formData.get("provider") ?? "");
  const key = String(formData.get("apiKey") ?? "").trim();
  const modelRaw = String(formData.get("model") ?? "").trim();
  const model = modelRaw === "" ? null : modelRaw;

  const v = validateProviderKey(provider, key, model);
  if (!v.ok) throw new Error(v.error);
  const p = provider as Provider;

  await prisma.providerKey.upsert({
    where: { userId_provider: { userId, provider: p } },
    create: { userId, provider: p, keyEnc: encrypt(key), model },
    update: { keyEnc: encrypt(key), model },
  });

  // If the user has no active provider yet, make this one active.
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { activeAiProvider: true },
  });
  if (!user?.activeAiProvider) {
    await prisma.user.update({ where: { id: userId }, data: { activeAiProvider: p } });
  }

  revalidatePath("/settings/api-keys");
}

export async function setActiveProvider(formData: FormData) {
  const userId = await requireUserId();
  const provider = String(formData.get("provider") ?? "") as Provider;
  const row = await prisma.providerKey.findUnique({
    where: { userId_provider: { userId, provider } },
  });
  if (!row) throw new Error("No saved key for that provider.");
  await prisma.user.update({ where: { id: userId }, data: { activeAiProvider: provider } });
  revalidatePath("/settings/api-keys");
}

export async function deleteProviderKey(formData: FormData) {
  const userId = await requireUserId();
  const provider = String(formData.get("provider") ?? "") as Provider;

  await prisma.providerKey.deleteMany({ where: { userId, provider } });

  // If we deleted the active provider, repoint to any remaining key, else null.
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { activeAiProvider: true },
  });
  if (user?.activeAiProvider === provider) {
    const remaining = await prisma.providerKey.findFirst({
      where: { userId },
      orderBy: { updatedAt: "desc" },
      select: { provider: true },
    });
    await prisma.user.update({
      where: { id: userId },
      data: { activeAiProvider: remaining?.provider ?? null },
    });
  }

  revalidatePath("/settings/api-keys");
}
```

- [ ] **Step 4: Run validation test, verify it passes**

Run: `npx vitest run src/lib/actions/api-keys.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Rewrite the Settings page**

```tsx
// src/app/(dashboard)/settings/api-keys/page.tsx
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import {
  saveProviderKey,
  setActiveProvider,
  deleteProviderKey,
} from "@/lib/actions/api-keys";

export const dynamic = "force-dynamic";

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic (Claude)",
  openai: "OpenAI",
  google: "Google (Gemini)",
  openrouter: "OpenRouter",
};

export default async function ApiKeysPage() {
  const session = await auth();
  if (!session?.user?.id) return null;

  const [keys, user] = await Promise.all([
    prisma.providerKey.findMany({
      where: { userId: session.user.id },
      select: { provider: true, model: true, updatedAt: true },
      orderBy: { provider: "asc" },
    }),
    prisma.user.findUnique({
      where: { id: session.user.id },
      select: { activeAiProvider: true },
    }),
  ]);
  const active = user?.activeAiProvider ?? null;

  return (
    <div className="max-w-2xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">API Keys</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Odyhook&apos;s AI features run against <strong>your own</strong> LLM
          provider key — Anthropic, OpenAI, Google, or OpenRouter. Usage is
          billed to you, not the platform. Keys are encrypted at rest with
          AES-256-GCM. Store keys for several providers and switch the active
          one anytime.
        </p>
      </div>

      <section className="rounded-lg border border-zinc-200 bg-white p-4 sm:p-6 dark:border-zinc-700 dark:bg-zinc-900">
        <h2 className="text-sm font-medium">Configured providers</h2>
        {keys.length === 0 ? (
          <p className="mt-2 text-sm text-amber-600">
            No provider configured. AI features are disabled until you add one.
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {keys.map((k) => (
              <li
                key={k.provider}
                className="flex items-center justify-between gap-3 rounded-md border border-zinc-100 px-3 py-2 text-sm dark:border-zinc-800"
              >
                <span>
                  <strong>{PROVIDER_LABELS[k.provider] ?? k.provider}</strong>
                  {k.model ? <span className="text-zinc-500"> · {k.model}</span> : null}
                  <span className="text-xs text-zinc-400">
                    {" "}· saved {k.updatedAt.toLocaleDateString()}
                  </span>
                </span>
                <span className="flex items-center gap-3">
                  {active === k.provider ? (
                    <span className="text-xs font-medium text-emerald-600">● active</span>
                  ) : (
                    <form action={setActiveProvider}>
                      <input type="hidden" name="provider" value={k.provider} />
                      <button type="submit" className="text-xs text-zinc-600 hover:underline dark:text-zinc-300">
                        Make active
                      </button>
                    </form>
                  )}
                  <form action={deleteProviderKey}>
                    <input type="hidden" name="provider" value={k.provider} />
                    <button type="submit" className="text-xs text-red-600 hover:underline">
                      Remove
                    </button>
                  </form>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-lg border border-zinc-200 bg-white p-4 sm:p-6 dark:border-zinc-700 dark:bg-zinc-900">
        <h2 className="text-sm font-medium">Add / replace a key</h2>
        <form action={saveProviderKey} className="mt-4 space-y-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-zinc-600 dark:text-zinc-400">Provider</span>
            <select
              name="provider"
              defaultValue="anthropic"
              className="h-9 rounded-md border border-zinc-200 bg-white px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            >
              <option value="anthropic">Anthropic (Claude)</option>
              <option value="openai">OpenAI</option>
              <option value="google">Google (Gemini)</option>
              <option value="openrouter">OpenRouter</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-zinc-600 dark:text-zinc-400">API key</span>
            <input
              name="apiKey"
              type="password"
              required
              placeholder="sk-ant-… / sk-… / AIza… / sk-or-…"
              className="h-9 rounded-md border border-zinc-200 bg-white px-3 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-zinc-600 dark:text-zinc-400">
              Model <span className="text-zinc-400">(OpenRouter only)</span>
            </span>
            <input
              name="model"
              type="text"
              placeholder="meta-llama/llama-3.3-70b-instruct"
              className="h-9 rounded-md border border-zinc-200 bg-white px-3 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
          <button
            type="submit"
            className="btn-primary-ody inline-flex h-9 items-center rounded-md px-4 text-sm font-medium"
          >
            Save key
          </button>
        </form>
      </section>
    </div>
  );
}
```

- [ ] **Step 6: Typecheck + full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: exit 0; all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/lib/actions/api-keys.ts src/lib/actions/api-keys.test.ts "src/app/(dashboard)/settings/api-keys/page.tsx"
git commit -m "feat(settings): multi-provider key management (save many, pick active)"
```

---

## Task 13: Docs — make BYOK provider-agnostic

**Files:** the AI feature docs, marketing security/subprocessors, infra/README, ARCHITECTURE, changelog.

- [ ] **Step 1: Feature docs** — in each file below, replace "your own Anthropic key" / "Anthropic API key" phrasing with provider-agnostic wording ("your own LLM provider key — Anthropic, OpenAI, Google, or OpenRouter"). Keep the Settings → API Keys path.
  - `src/app/(marketing)/docs/ai-filters-and-transforms/page.mdx` (the "Bring your own key" section)
  - `src/app/(marketing)/docs/ai-event-diffs/page.mdx` (the BYOK sentence)
  - `src/app/(marketing)/docs/nl-event-search/page.mdx`
  - `src/app/(marketing)/docs/mcp/page.mdx` (the "BYOK tools (require your own Anthropic key)" line → "require your own LLM provider key")
  - `src/app/(marketing)/docs/cli/page.mdx`

- [ ] **Step 2: Marketing security/subprocessors**
  - `src/app/(marketing)/security/page.tsx` line ~65: "BYOK Anthropic keys" → "BYOK LLM provider keys".
  - `src/app/(marketing)/subprocessors/page.tsx`: update any "Anthropic" BYOK mention to note keys are per-user for the provider the user chooses (Anthropic, OpenAI, Google, or OpenRouter).

- [ ] **Step 3: infra/README + ARCHITECTURE**
  - `infra/README.md`: the "Anthropic is BYOK" decision-log bullet and the `ENCRYPTION_KEY` / API-key rows — note keys are now per-provider (Anthropic, OpenAI, Google, OpenRouter), one active at a time.
  - `ARCHITECTURE.md`: update the BYOK / AI row to say multi-provider.
  > Note: `ARCHITECTURE.md` has unrelated uncommitted edits in the working tree — stage only your BYOK changes (`git add -p`).

- [ ] **Step 4: Changelog**
  - `src/app/(marketing)/changelog/page.mdx`: add a dated entry — "Multi-provider BYOK: AI features now run on Anthropic, OpenAI, Google Gemini, or any model via OpenRouter."

- [ ] **Step 5: Typecheck (mdx/tsx compile) + commit**

Run: `npx tsc --noEmit`
Expected: exit 0.

```bash
git add -p
git commit -m "docs: BYOK is now multi-provider (Anthropic/OpenAI/Google/OpenRouter)"
```

---

## Task 14: Final verification

- [ ] **Step 1: Full gate (mirrors CI)**

Run: `npx tsc --noEmit && npx vitest run`
Expected: exit 0; entire suite green, including the new adapter/factory/settings tests and the refactored module tests.

- [ ] **Step 2: Grep for stragglers**

Run: `grep -rn "anthropicFor\|getUserApiKey\|NoUserApiKeyError\|MODEL_DEFAULT\|MODEL_CHEAP\|userApiKey\|UserApiKey" src --include="*.ts" --include="*.tsx" | grep -v "src/generated/"`
Expected: no matches (all references migrated; generated Prisma client no longer references `UserApiKey` after Task 7's regenerate).

- [ ] **Step 3: Manual smoke (optional, requires local dev DB + a real provider key)**

Start `npm run dev`, go to Settings → API Keys, add a key for a non-Anthropic provider, make it active, then exercise an AI feature (e.g. compile a filter). Confirm it routes to the chosen provider.

---

## Self-review notes (for the author)

- **Spec coverage:** providers (Tasks 3–6, 8), curated tiers (Task 2 model table; tier passed in Tasks 9–10), save-many/pick-active (Tasks 7, 12), native-adapters-behind-interface (Tasks 2–8), migration (Task 7), settings UI (Task 12), error handling (Task 11), docs (Task 13), tests (every TDD task + Task 14). ✅
- **Deviations from spec (intentional, smaller):** `complete()` returns `{ text, model }` not bare `string` (three features persist the model id); `getActiveLlm` dropped (the fixtures route uses `llmFor` + catch). Both noted to the user.
- **Type consistency:** `LlmClient.complete` shape, `CompleteArgs`/`CompleteResult`, `Provider`/`Tier`, `PROVIDER_MODELS`, `userId_provider` composite-key where-clause, and the `llm:` param name are used identically across all tasks.
