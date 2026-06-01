# AI Test-Fixture Generation (`ody trigger --generate`) Implementation Plan

> **Status: ✅ Complete (2026-05-31).** Tasks 1–5 implemented via subagent-driven development,
> each through two-stage review (spec + code quality) plus a final whole-feature review
> (verdict: ready to merge). Verified: 304 server tests + 27 CLI tests green, both `tsc` clean,
> `npm run build` passes with `/api/v1/fixtures` registered. Shipped in **PR #7**. Task 6
> (manual smoke test) remains for the maintainer to run against the dev stack with a real
> Anthropic key.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a developer run `ody trigger <slug> --generate "<description>"` to have Claude generate a realistic JSON webhook fixture (grounded in the source's real event history) and deliver it through the existing ingest path.

**Architecture:** A new `POST /api/v1/fixtures` endpoint generates the fixture **server-side** using the user's BYOK Anthropic key (the CLI has no key). The endpoint authenticates + verifies source ownership, grounds Claude on up to 5 recent event bodies plus the source's `verifyStyle` hint, and returns the generated JSON as a string. The CLI prints it and (unless `--dry-run`) POSTs it to `/api/ingest/<slug>` through the same send-path `trigger --data` already uses.

**Tech Stack:** TypeScript, Next.js 16 App Router (Node runtime), Prisma 7, `@anthropic-ai/sdk`, Zod, Vitest. CLI: Node ≥20 (`fetch`, `util.parseArgs` built-ins), Vitest.

Design spec: [docs/superpowers/specs/2026-05-31-ai-fixtures-design.md](../specs/2026-05-31-ai-fixtures-design.md).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/ai/json.ts` (create) | `extractJsonText(text)` — strip ```` ``` ```` code-fences from a model response. Shared by the rule compiler and fixtures. |
| `src/lib/ai/json.test.ts` (create) | Unit tests for `extractJsonText`. |
| `src/lib/ai/rule-compiler.ts` (modify) | Replace its inline fence-strip with `extractJsonText` (no behaviour change). |
| `src/lib/ai/fixtures.ts` (create) | `generateFixture(opts)` — build the grounded prompt, call the injected Anthropic client, extract + validate JSON, return `{ body, model, groundedOn }`. |
| `src/lib/ai/fixtures.test.ts` (create) | Unit tests with a fake Anthropic client (no network). |
| `src/app/api/v1/fixtures/route.ts` (create) | `POST` endpoint: auth → own(source) → fetch samples → key check → `generateFixture` → JSON. |
| `src/app/api/v1/fixtures/route.test.ts` (create) | Auth / ownership / no-key tests (network-free). |
| `cli/src/commands/trigger.ts` (modify) | Add `--generate` / `--dry-run`; `resolveTriggerMode`, `buildGenerateRequest`, `generateAndSend`. |
| `cli/src/commands/trigger.test.ts` (modify) | Tests for the new pure helpers + the generate/dry-run flow (injected fetch). |
| `cli/src/index.ts` (modify) | Update the `trigger` usage text. |
| `cli/README.md` (modify) | "Generate test events" section. |
| `infra/README.md` (modify) | Note the new `/api/v1/fixtures` endpoint. |

---

## Task 1: Extract `extractJsonText` helper + refactor the rule compiler

**Files:**
- Create: `src/lib/ai/json.ts`, `src/lib/ai/json.test.ts`
- Modify: `src/lib/ai/rule-compiler.ts`

- [x] **Step 1: Write the failing test**

Create `src/lib/ai/json.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { extractJsonText } from "./json";

describe("extractJsonText", () => {
  it("returns bare JSON unchanged (trimmed)", () => {
    expect(extractJsonText('  {"a":1}  ')).toBe('{"a":1}');
  });

  it("strips a ```json fence", () => {
    expect(extractJsonText('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("strips a bare ``` fence", () => {
    expect(extractJsonText('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("leaves non-JSON text for the caller's JSON.parse to reject", () => {
    expect(extractJsonText("not json at all")).toBe("not json at all");
  });
});
```

- [x] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run src/lib/ai/json.test.ts`
Expected: FAIL with "Cannot find module './json'".

- [x] **Step 3: Implement the helper**

Create `src/lib/ai/json.ts`:

```ts
/**
 * Strip Markdown code-fences (```` ``` ```` or ```` ```json ````) that a model
 * sometimes wraps JSON in, returning the inner text trimmed. Does NOT validate
 * that the result is JSON — the caller runs JSON.parse and handles failure.
 */
export function extractJsonText(text: string): string {
  let raw = text.trim();
  if (raw.startsWith("```")) {
    raw = raw
      .replace(/^```(?:json)?\n/, "")
      .replace(/\n```$/, "")
      .trim();
  }
  return raw;
}
```

- [x] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run src/lib/ai/json.test.ts`
Expected: PASS (4 tests).

- [x] **Step 5: Refactor the rule compiler to use it**

In [src/lib/ai/rule-compiler.ts](../../../src/lib/ai/rule-compiler.ts), add this import below the existing imports at the top:

```ts
import { extractJsonText } from "./json";
```

Then replace this block:

```ts
  let raw = textBlock.text.trim();
  if (raw.startsWith("```")) {
    raw = raw
      .replace(/^```(?:json)?\n/, "")
      .replace(/\n```$/, "")
      .trim();
  }
```

with:

```ts
  const raw = extractJsonText(textBlock.text);
```

- [x] **Step 6: Confirm the server build still passes**

Run: `npx tsc --noEmit`
Expected: no type errors.

- [x] **Step 7: Commit**

```bash
git add src/lib/ai/json.ts src/lib/ai/json.test.ts src/lib/ai/rule-compiler.ts
git commit -m "refactor(ai): extract shared extractJsonText helper"
```

---

## Task 2: `generateFixture` — the grounded generator

**Files:**
- Create: `src/lib/ai/fixtures.ts`, `src/lib/ai/fixtures.test.ts`

The generator takes an **injected** Anthropic client so it is unit-testable with a fake — no network, no real key. The route (Task 3) constructs the real client and passes it in.

- [x] **Step 1: Write the failing test**

Create `src/lib/ai/fixtures.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { generateFixture } from "./fixtures";

/** A fake Anthropic client whose messages.create returns a fixed text block. */
function fakeClient(text: string): Anthropic {
  return {
    messages: {
      create: async () => ({ content: [{ type: "text", text }] }),
    },
  } as unknown as Anthropic;
}

describe("generateFixture", () => {
  it("returns the parsed body and groundedOn = sample count", async () => {
    const res = await generateFixture({
      anthropic: fakeClient('```json\n{"amount":5000,"currency":"usd"}\n```'),
      prompt: "a stripe payment for $50",
      sampleBodies: ['{"id":"evt_old"}', '{"id":"evt_older"}'],
      verifyStyle: "stripe",
    });
    expect(JSON.parse(res.body)).toEqual({ amount: 5000, currency: "usd" });
    expect(res.groundedOn).toBe(2);
    expect(res.model).toBeTruthy();
  });

  it("works with zero samples (groundedOn = 0)", async () => {
    const res = await generateFixture({
      anthropic: fakeClient('{"ok":true}'),
      prompt: "anything",
      sampleBodies: [],
      verifyStyle: null,
    });
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    expect(res.groundedOn).toBe(0);
  });

  it("throws when the model returns non-JSON", async () => {
    await expect(
      generateFixture({
        anthropic: fakeClient("sorry, I cannot do that"),
        prompt: "x",
        sampleBodies: [],
        verifyStyle: null,
      }),
    ).rejects.toThrow(/valid JSON/i);
  });
});
```

- [x] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run src/lib/ai/fixtures.test.ts`
Expected: FAIL with "Cannot find module './fixtures'".

- [x] **Step 3: Implement the generator**

Create `src/lib/ai/fixtures.ts`:

```ts
import type Anthropic from "@anthropic-ai/sdk";

import { MODEL_DEFAULT } from "@/lib/anthropic";
import { extractJsonText } from "./json";

const SYSTEM_PROMPT = `You generate a single realistic webhook payload, as JSON, for testing a developer's integration.

Rules:
- Output ONLY one JSON object — no prose, no markdown, no code fences.
- Make the payload realistic for the event the user describes: plausible ids, amounts, timestamps, and nested structure.
- If recent real payloads for this source are provided, match their field names and shape closely.
- If a provider is hinted (e.g. "stripe", "github"), follow that provider's known payload conventions.
- Do not include signature/credential headers — only the request body JSON.`;

export type FixtureResult = {
  /** The generated payload as a JSON string, ready to POST as a request body. */
  body: string;
  /** The model that produced it. */
  model: string;
  /** How many real sample events grounded the generation (0 if none). */
  groundedOn: number;
};

export type GenerateFixtureOpts = {
  anthropic: Anthropic;
  prompt: string;
  sampleBodies: string[];
  verifyStyle: string | null;
};

/**
 * Ask Claude to generate one realistic webhook fixture for `prompt`, grounded
 * in up to 5 recent sample bodies and the source's provider hint. Returns the
 * payload as a JSON string. Throws if the model does not return valid JSON.
 */
export async function generateFixture(opts: GenerateFixtureOpts): Promise<FixtureResult> {
  const { anthropic, prompt, sampleBodies, verifyStyle } = opts;
  const samples = sampleBodies.slice(0, 5);

  const parts = [`Describe the event to generate: ${prompt}`];
  if (verifyStyle) parts.push(`Provider hint: ${verifyStyle}`);
  if (samples.length > 0) {
    parts.push(
      `Recent real payloads for this source — match their shape:`,
      "```json",
      samples.join("\n---\n").slice(0, 6000),
      "```",
    );
  }
  parts.push("Output ONLY the JSON object for the new payload.");

  const response = await anthropic.messages.create({
    model: MODEL_DEFAULT,
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: parts.join("\n") }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("the model did not return valid JSON (no text content)");
  }

  const raw = extractJsonText(textBlock.text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("the model did not return valid JSON — try rephrasing the description");
  }

  return {
    body: JSON.stringify(parsed),
    model: MODEL_DEFAULT,
    groundedOn: samples.length,
  };
}
```

- [x] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run src/lib/ai/fixtures.test.ts`
Expected: PASS (3 tests).

- [x] **Step 5: Confirm the server build still passes**

Run: `npx tsc --noEmit`
Expected: no type errors.

- [x] **Step 6: Commit**

```bash
git add src/lib/ai/fixtures.ts src/lib/ai/fixtures.test.ts
git commit -m "feat(ai): generateFixture — grounded webhook fixture generation"
```

---

## Task 3: `POST /api/v1/fixtures` endpoint

**Files:**
- Create: `src/app/api/v1/fixtures/route.ts`, `src/app/api/v1/fixtures/route.test.ts`

The route is a thin wrapper: validate input → verify source ownership → load samples →
check the user has an Anthropic key (null → 400, network-free) → construct the client →
`generateFixture`. The success (200) path requires a real Claude call, so it is verified by
the CLI flow test (Task 4) and the manual smoke test (Task 6) rather than here — these tests
cover every branch that short-circuits *before* the Claude call.

- [x] **Step 1: Write the failing test**

Create `src/app/api/v1/fixtures/route.test.ts`:

```ts
import "dotenv/config";
import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/prisma";
import { generateToken } from "@/lib/api/token";
import { POST } from "./route";

async function makeUserWithToken() {
  const user = await prisma.user.create({
    data: { email: `h-fixtures-${Date.now()}-${Math.random()}@test.local` },
  });
  const t = generateToken();
  await prisma.apiToken.create({
    data: { userId: user.id, name: "t", tokenHash: t.hash, prefix: t.prefix },
  });
  return { user, raw: t.raw };
}

function postReq(raw: string | null, body: unknown): Request {
  return new Request("https://x/api/v1/fixtures", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(raw ? { authorization: `Bearer ${raw}` } : {}),
    },
    body: JSON.stringify(body),
  });
}
const ctx = { params: Promise.resolve({}) };

describe("POST /api/v1/fixtures", () => {
  it("401s without a token", async () => {
    const res = await POST(postReq(null, { source: "foo", prompt: "x" }), ctx);
    expect(res.status).toBe(401);
  });

  it("404s for an unknown source slug", async () => {
    const { raw } = await makeUserWithToken();
    const res = await POST(postReq(raw, { source: "nope-nope", prompt: "x" }), ctx);
    expect(res.status).toBe(404);
  });

  it("404s for another user's source", async () => {
    const a = await makeUserWithToken();
    const b = await makeUserWithToken();
    const src = await prisma.source.create({
      data: { userId: a.user.id, name: "A", slug: `fa-${Date.now()}` },
    });
    const res = await POST(postReq(b.raw, { source: src.slug, prompt: "x" }), ctx);
    expect(res.status).toBe(404);
  });

  it("400s when the user has no Anthropic key configured", async () => {
    const a = await makeUserWithToken();
    const src = await prisma.source.create({
      data: { userId: a.user.id, name: "B", slug: `fb-${Date.now()}` },
    });
    const res = await POST(postReq(a.raw, { source: src.slug, prompt: "a test event" }), ctx);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toMatch(/API key/i);
  });
});
```

- [x] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run src/app/api/v1/fixtures/route.test.ts`
Expected: FAIL with "Cannot find module './route'".

- [x] **Step 3: Implement the route**

Create `src/app/api/v1/fixtures/route.ts`:

```ts
import { NextResponse } from "next/server";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";

import { withApiAuth, readJson, apiError } from "@/lib/api/handler";
import { prisma } from "@/lib/prisma";
import { getUserApiKey } from "@/lib/anthropic";
import { generateFixture } from "@/lib/ai/fixtures";

export const runtime = "nodejs";

const FixtureInput = z.object({
  source: z.string().min(1),
  prompt: z.string().min(1),
});

export const POST = withApiAuth(async (req, auth) => {
  const { source, prompt } = FixtureInput.parse(await readJson(req));

  const src = await prisma.source.findFirst({
    where: { slug: source, userId: auth.userId },
    select: { id: true, verifyStyle: true },
  });
  if (!src) return apiError("not_found", "source not found");

  const apiKey = await getUserApiKey(auth.userId);
  if (!apiKey) {
    return apiError(
      "validation_error",
      "No Anthropic API key configured (set one in Settings → API Keys).",
    );
  }

  const samples = await prisma.event.findMany({
    where: { sourceId: src.id },
    orderBy: { receivedAt: "desc" },
    take: 5,
    select: { bodyRaw: true },
  });

  try {
    const result = await generateFixture({
      anthropic: new Anthropic({ apiKey }),
      prompt,
      sampleBodies: samples.map((s) => s.bodyRaw),
      verifyStyle: src.verifyStyle,
    });
    return NextResponse.json(result);
  } catch (err) {
    return apiError(
      "validation_error",
      err instanceof Error ? err.message : "fixture generation failed",
    );
  }
});
```

- [x] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run src/app/api/v1/fixtures/route.test.ts`
Expected: PASS (4 tests).

- [x] **Step 5: Confirm the server build still passes**

Run: `npx tsc --noEmit`
Expected: no type errors.

- [x] **Step 6: Commit**

```bash
git add src/app/api/v1/fixtures/
git commit -m "feat(api): POST /api/v1/fixtures — AI fixture generation endpoint"
```

---

## Task 4: CLI `ody trigger --generate` / `--dry-run`

**Files:**
- Modify: `cli/src/commands/trigger.ts`, `cli/src/commands/trigger.test.ts`, `cli/src/index.ts`

- [x] **Step 1: Write the failing tests**

Append to `cli/src/commands/trigger.test.ts`:

```ts
import { resolveTriggerMode, buildGenerateRequest, generateAndSend } from "./trigger";
import type { Config } from "../config";

describe("resolveTriggerMode", () => {
  it("returns the single chosen mode", () => {
    expect(resolveTriggerMode({ data: "@f.json" })).toEqual({ mode: "data" });
    expect(resolveTriggerMode({ replay: "evt_1" })).toEqual({ mode: "replay" });
    expect(resolveTriggerMode({ generate: "a test" })).toEqual({ mode: "generate" });
  });
  it("errors when none are provided", () => {
    expect(resolveTriggerMode({})).toEqual({
      error: "Provide one of --data, --replay, or --generate.",
    });
  });
  it("errors when more than one is provided", () => {
    const r = resolveTriggerMode({ data: "@f.json", generate: "x" });
    expect("error" in r && r.error).toMatch(/mutually exclusive/i);
  });
});

describe("buildGenerateRequest", () => {
  it("targets /api/v1/fixtures with bearer auth and {source,prompt}", () => {
    const cfg: Config = { host: "https://odyhook.dev", token: "ody_x" };
    const req = buildGenerateRequest(cfg, "gh-prod", "a push event");
    expect(req.url).toBe("https://odyhook.dev/api/v1/fixtures");
    expect(req.headers.authorization).toBe("Bearer ody_x");
    expect(req.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(req.body)).toEqual({ source: "gh-prod", prompt: "a push event" });
  });
});

describe("generateAndSend", () => {
  const cfg: Config = { host: "https://odyhook.dev", token: "ody_x" };

  it("generates then POSTs the fixture to ingest", async () => {
    const calls: string[] = [];
    const fakeFetch = (async (url: string) => {
      calls.push(url);
      if (url.includes("/api/v1/fixtures")) {
        return new Response(
          JSON.stringify({ body: '{"hello":"world"}', model: "m", groundedOn: 0 }),
          { status: 200 },
        );
      }
      return new Response("accepted", { status: 202 });
    }) as unknown as typeof fetch;

    await generateAndSend(cfg, "gh-prod", "a test event", { dryRun: false, headers: {} }, fakeFetch);

    expect(calls).toEqual([
      "https://odyhook.dev/api/v1/fixtures",
      "https://odyhook.dev/api/ingest/gh-prod",
    ]);
  });

  it("with dryRun, generates but does NOT POST to ingest", async () => {
    const calls: string[] = [];
    const fakeFetch = (async (url: string) => {
      calls.push(url);
      return new Response(
        JSON.stringify({ body: '{"hello":"world"}', model: "m", groundedOn: 0 }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    await generateAndSend(cfg, "gh-prod", "a test event", { dryRun: true, headers: {} }, fakeFetch);

    expect(calls).toEqual(["https://odyhook.dev/api/v1/fixtures"]);
  });
});
```

- [x] **Step 2: Run the tests and confirm they fail**

Run: `cd cli && npx vitest run src/commands/trigger.test.ts`
Expected: FAIL with "resolveTriggerMode is not exported" (or similar).

- [x] **Step 3: Implement the helpers and wire the flow**

Edit `cli/src/commands/trigger.ts`.

First, replace the import on line 5 so `authHeaders` and `apiUrl` are both available (they already are — leave as is) and add `parseHeaderFlags` stays. No import change needed beyond what exists; the file already imports `apiUrl, authHeaders` from `../http.js`.

Add these exports near the top of the file, after the existing `buildTriggerRequest` function:

```ts
type TriggerValues = { data?: string; replay?: string; generate?: string };

/** Pick the single input mode, or return a usage error if 0 or >1 are given. */
export function resolveTriggerMode(
  v: TriggerValues,
): { mode: "data" | "replay" | "generate" } | { error: string } {
  const chosen = (["data", "replay", "generate"] as const).filter((k) => v[k] != null);
  if (chosen.length === 0) return { error: "Provide one of --data, --replay, or --generate." };
  if (chosen.length > 1) {
    return { error: `--data, --replay, and --generate are mutually exclusive (got ${chosen.join(", ")}).` };
  }
  return { mode: chosen[0] };
}

/** Build the POST to the server-side fixture generator. */
export function buildGenerateRequest(cfg: Config, slug: string, prompt: string): TriggerRequest {
  return {
    url: apiUrl(cfg, "/api/v1/fixtures"),
    method: "POST",
    headers: { ...authHeaders(cfg), "content-type": "application/json" },
    body: JSON.stringify({ source: slug, prompt }),
  };
}

type GenerateResult = { body: string; model: string; groundedOn: number };

/**
 * Generate a fixture via the server, print it, and (unless dryRun) POST it to
 * the source's ingest URL. Exported for testing with an injected fetch.
 */
export async function generateAndSend(
  cfg: Config,
  slug: string,
  prompt: string,
  opts: { dryRun: boolean; headers: Record<string, string> },
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const gen = buildGenerateRequest(cfg, slug, prompt);
  const res = await fetchImpl(gen.url, { method: gen.method, headers: gen.headers, body: gen.body });
  if (res.status === 401) {
    console.error("Token rejected; re-run `ody login`.");
    process.exitCode = 1;
    return;
  }
  if (res.status === 404) {
    console.error(`Source not found: ${slug}`);
    process.exitCode = 1;
    return;
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { error?: { message?: string } };
      if (j.error?.message) msg = j.error.message;
    } catch {
      /* non-JSON error body */
    }
    console.error(`Generation failed: ${msg}`);
    process.exitCode = 1;
    return;
  }

  const result = (await res.json()) as GenerateResult;
  const grounded = result.groundedOn > 0 ? ` (grounded on ${result.groundedOn} recent event(s))` : "";
  console.log(`Generated fixture${grounded}:`);
  console.log(result.body);

  if (opts.dryRun) return;

  const send = buildTriggerRequest(cfg, slug, result.body, opts.headers);
  const sent = await fetchImpl(send.url, { method: send.method, headers: send.headers, body: send.body });
  const text = await sent.text();
  console.log(`HTTP ${sent.status}  ${text}`);
  if (!sent.ok) process.exitCode = 1;
}
```

Now update `trigger()` itself. Change the `parseArgs` options block to add `generate` and `dry-run`:

```ts
    options: {
      data: { type: "string" },
      replay: { type: "string" },
      generate: { type: "string" },
      "dry-run": { type: "boolean" },
      header: { type: "string", multiple: true },
    },
```

Then replace the entire mode-dispatch body of `trigger()` — everything from `let req: TriggerRequest;` (line 72) down to the end of the function — with:

```ts
  const mode = resolveTriggerMode(values);
  if ("error" in mode) {
    console.error(mode.error);
    process.exitCode = 1;
    return;
  }

  if (mode.mode === "generate") {
    await generateAndSend(cfg, slug, values.generate!, {
      dryRun: Boolean(values["dry-run"]),
      headers: parseHeaderFlags(values.header ?? []),
    });
    return;
  }

  let req: TriggerRequest;
  if (mode.mode === "replay") {
    const res = await fetch(apiUrl(cfg, `/api/v1/events/${values.replay}`), {
      headers: authHeaders(cfg),
    });
    if (res.status === 404) {
      console.error(`Event not found: ${values.replay}`);
      process.exitCode = 1;
      return;
    }
    if (!res.ok) {
      console.error(`Failed to load event (HTTP ${res.status})`);
      process.exitCode = 1;
      return;
    }
    const evt = (await res.json()) as EventPayload;
    req = {
      url: apiUrl(cfg, `/api/ingest/${slug}`),
      method: "POST",
      headers: filterHeaders(evt.headersJson),
      body: evt.bodyRaw,
    };
    console.log(`Replaying ${values.replay} into "${slug}" (a new event will be created; identical bodies may be de-duped)`);
  } else {
    req = buildTriggerRequest(cfg, slug, readData(values.data!), parseHeaderFlags(values.header ?? []));
  }

  const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
  const text = await res.text();
  console.log(`HTTP ${res.status}  ${text}`);
  if (!res.ok) process.exitCode = 1;
```

Also update the early usage hint near the top of `trigger()` (the `if (!slug)` block) to mention `--generate`:

```ts
    console.error("Usage: ody trigger <slug> (--data @file.json | --replay <eventId> | --generate \"<description>\") [--dry-run]");
```

- [x] **Step 4: Run the tests and confirm they pass**

Run: `cd cli && npx vitest run src/commands/trigger.test.ts`
Expected: PASS (all trigger tests, including the new ones).

- [x] **Step 5: Update the dispatcher usage text**

In `cli/src/index.ts`, replace the two `ody trigger …` lines in `printUsage()` with three:

```ts
      "  ody trigger <slug> --data @file.json [--header K:V]...",
      "  ody trigger <slug> --replay <eventId>",
      '  ody trigger <slug> --generate "<description>" [--dry-run]',
```

- [x] **Step 6: Confirm the CLI build passes**

Run: `cd cli && npx tsc --noEmit`
Expected: no type errors.

- [x] **Step 7: Commit**

```bash
git add cli/src/commands/trigger.ts cli/src/commands/trigger.test.ts cli/src/index.ts
git commit -m "feat(cli): ody trigger --generate (AI fixtures) + --dry-run"
```

---

## Task 5: Docs — CLI README + infra note

**Files:**
- Modify: `cli/README.md`, `infra/README.md`

- [x] **Step 1: Add a "Generate test events" section to the CLI README**

In [cli/README.md](../../../cli/README.md), immediately after the existing "Trigger test events"
section, add:

```markdown
## Generate test events with AI

Describe the event you want in plain English and let your instance's Claude key
(Settings → API Keys) write a realistic payload for you, grounded in the source's
recent real events:

```sh
ody trigger gh-prod --generate "a push to main with two commits from a new contributor"
```

Preview without sending (prints the fixture only):

```sh
ody trigger gh-prod --generate "a stripe payment_intent.succeeded for $50" --dry-run
```

Generation runs server-side using your own BYOK Anthropic key — the CLI never sees it.
The generated body is delivered through the same ingest path as `--data`, so if the
source has signature verification enabled the unsigned fixture is rejected just like a
hand-written `--data` payload.
```

- [x] **Step 2: Add an infra note for the endpoint**

In [infra/README.md](../../../infra/README.md), near the existing `GET /api/v1/listen` bullet
in the "Notable endpoints" area, add:

```markdown
- **`POST /api/v1/fixtures`** generates a realistic test payload from a plain-English
  description for the `ody trigger --generate` command. It runs server-side using the
  authenticated user's BYOK Anthropic key (`anthropicFor`), grounded on up to 5 recent
  events for the source. It generates only — the CLI delivers the result through the normal
  `/api/ingest/<slug>` path.
```

- [x] **Step 3: Commit**

```bash
git add cli/README.md infra/README.md
git commit -m "docs: document ody trigger --generate + the /api/v1/fixtures endpoint"
```

---

## Task 6: Manual smoke test against the dev stack

**Files:** none — verification only.

- [ ] **Step 1: Boot the dev stack** (separate terminals)

```sh
docker compose up -d        # postgres + redis + mailhog
npm run dev                 # Next.js at :3000
```

- [ ] **Step 2: Configure a BYOK key + log the CLI in**

In the dashboard (`http://localhost:3000`, sign in via MailHog at `:8025`):
1. Settings → API Keys: paste a real `sk-ant-…` Anthropic key (generation needs it).
2. Settings → API Tokens: create an `ody_…` token, copy it.

```sh
cd cli && npx tsx src/index.ts login
# host: http://localhost:3000   token: ody_…
```

- [ ] **Step 3: Dry-run a generation**

```sh
cd cli && npx tsx src/index.ts trigger <your-slug> --generate "a stripe payment_intent.succeeded for \$50" --dry-run
```

Expected: prints `Generated fixture…:` followed by a realistic JSON object; nothing is sent.

- [ ] **Step 4: Generate and send**

```sh
cd cli && npx tsx src/index.ts trigger <your-slug> --generate "a github push with two commits"
```

Expected: prints the generated fixture, then `HTTP 202  {…eventId…}`. A new event appears on
the Events page.

- [ ] **Step 5: Verify the no-key error path**

Temporarily remove the Anthropic key (Settings → API Keys), then re-run Step 4. Expected:
`Generation failed: No Anthropic API key configured (set one in Settings → API Keys).` and a
non-zero exit. Restore the key afterward.

- [ ] **Step 6: Verify mutual exclusivity**

```sh
cd cli && npx tsx src/index.ts trigger <your-slug> --generate "x" --data '{}'
```

Expected: `--data, --replay, and --generate are mutually exclusive (got data, generate).`

- [ ] **Step 7:** If any step fails, fix and re-test before marking complete.

---

## Verification (overall)

From the repo root:

```bash
cd cli && npx vitest run && npx tsc --noEmit && cd ..   # CLI tests + types
npx vitest run                                          # server tests (Redis + Postgres up)
npx tsc --noEmit                                        # server types
npm run build                                           # Next.js production build
```

Plus the manual smoke flow in Task 6.

---

## Out of scope (deferred)

- Provider/event-type flags (`--provider stripe --event …`) — needs a maintained taxonomy.
- Generating multiple fixtures in one call.
- AI-suggested headers (e.g. `X-GitHub-Event`) returned alongside the body.
- A saved/named fixture library on disk.
- A separate `ody generate` subcommand (`--generate --dry-run` already prints without sending).
- Publishing the CLI to npm / wiring CLI tests into root CI (unchanged from the `ody-cli` plan).
```
