# Public REST API (`/api/v1`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Ship a versioned, API-token-authenticated REST API (`/api/v1`) for full programmatic management of sources/destinations/routes plus read-only access to events/deliveries.

**Architecture:** A shared **service layer** (`src/lib/services/*`) owns all validation + DB writes and returns secret-free DTOs. The existing session-authed **Server Actions** and the new token-authed **API route handlers** are both thin edges over that layer, so the UI and API can never drift. API auth is a hashed bearer token (`ApiToken` model). List endpoints use cursor pagination; the API is rate-limited per token via the existing Redis token-bucket.

**Tech Stack:** Next.js 16 (App Router route handlers), Prisma 7, Zod, Vitest 4, Redis (ioredis), Node `crypto`.

---

## Conventions used throughout this plan

- **Run tests:** `npm test -- <path>` (alias for `vitest run`). DB-touching tests need a local Postgres — start it with `docker compose up -d` first. They load creds via `import "dotenv/config"` and the real `prisma` client, creating records with unique emails/slugs (`${Date.now()}-${Math.random()}`), exactly like `src/lib/metrics/queries.test.ts`.
- **Prisma client:** `import { prisma } from "@/lib/prisma";`
- **Migrations:** `npm run db:migrate` (prisma migrate dev). After editing `schema.prisma`, this regenerates the client into `src/generated/prisma`.
- **Commit after each task.** Branch is `feat/public-rest-api` (already created).

---

## File structure

**Created:**
- `src/lib/api/token.ts` — token generate/hash/parse (pure)
- `src/lib/api/token.test.ts`
- `src/lib/api/authenticate.ts` — bearer → `{ userId, tokenId }`
- `src/lib/api/respond.ts` — JSON error/success + pagination helpers
- `src/lib/api/respond.test.ts`
- `src/lib/services/sources.ts` + `.test.ts`
- `src/lib/services/destinations.ts` + `.test.ts`
- `src/lib/services/routes.ts` + `.test.ts`
- `src/lib/services/events.ts` + `.test.ts`
- `src/lib/actions/api-tokens.ts` — session-authed token management actions
- `src/app/api/v1/sources/route.ts` + `[id]/route.ts`
- `src/app/api/v1/destinations/route.ts` + `[id]/route.ts`
- `src/app/api/v1/routes/route.ts` + `[id]/route.ts`
- `src/app/api/v1/events/route.ts` + `[id]/route.ts`
- `src/app/api/v1/sources/route.test.ts` (one handler test file per resource; see tasks)
- `src/app/(dashboard)/settings/api-tokens/page.tsx`
- `public/openapi.json`

**Modified:**
- `prisma/schema.prisma` — add `ApiToken` model + `User.apiTokens`
- `src/lib/ratelimit.ts` — add `defaultApiConfig()` + `checkApiRateLimit()`
- `src/lib/actions/sources.ts` — refactor to call service
- `src/lib/actions/destinations.ts` — refactor to call service
- `src/lib/actions/routes.ts` — refactor to call service (keep `toggleRoute`)
- settings nav (wherever `/settings/api-keys` is linked) — add `/settings/api-tokens` link
- `infra/README.md` — document `API_RATE_LIMIT_*` env vars

---

## Task 1: `ApiToken` model + migration

**Files:**
- Modify: `prisma/schema.prisma`

- [x] **Step 1: Add the model and back-relation**

In `prisma/schema.prisma`, add `apiTokens ApiToken[]` to the `User` model's relation list (next to `apiKey UserApiKey?`):

```prisma
  apiKey       UserApiKey?
  apiTokens    ApiToken[]
```

Then add this model after `UserApiKey`:

```prisma
// Programmatic access tokens for the public REST API (/api/v1). Distinct from
// UserApiKey (which holds the *encrypted* Anthropic BYOK key): API tokens are
// HASHED, not encrypted — we only ever verify a presented token, never recover
// it. A user can mint many; each is shown in full exactly once at creation.
model ApiToken {
  id         String    @id @default(cuid())
  userId     String
  name       String // human label: "my-laptop", "terraform"
  tokenHash  String    @unique // sha256(raw token), hex
  prefix     String // first chars shown in UI: "ody_a1b2"
  lastUsedAt DateTime?
  revokedAt  DateTime?
  createdAt  DateTime  @default(now())

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
}
```

- [x] **Step 2: Create the migration**

Run: `npm run db:migrate -- --name add_api_token`
Expected: a new folder under `prisma/migrations/`, and "Your database is now in sync". The Prisma client regenerates so `prisma.apiToken` exists.

- [x] **Step 3: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(api): add ApiToken model for public REST API auth"
```

---

## Task 2: Token primitives (`src/lib/api/token.ts`)

Pure functions — no DB, fast unit test.

**Files:**
- Create: `src/lib/api/token.ts`
- Test: `src/lib/api/token.test.ts`

- [x] **Step 1: Write the failing test**

```ts
// src/lib/api/token.test.ts
import { describe, it, expect } from "vitest";
import { generateToken, hashToken, parseBearer } from "./token";

describe("token primitives", () => {
  it("generates an ody_ token whose hash matches hashToken(raw)", () => {
    const t = generateToken();
    expect(t.raw.startsWith("ody_")).toBe(true);
    expect(t.prefix).toBe(t.raw.slice(0, 8));
    expect(t.hash).toBe(hashToken(t.raw));
    expect(t.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("generates unique tokens", () => {
    expect(generateToken().raw).not.toBe(generateToken().raw);
  });

  it("parses a Bearer header and rejects junk", () => {
    expect(parseBearer("Bearer ody_abc")).toBe("ody_abc");
    expect(parseBearer("bearer ody_abc")).toBe("ody_abc"); // case-insensitive scheme
    expect(parseBearer("Token ody_abc")).toBeNull();
    expect(parseBearer(null)).toBeNull();
    expect(parseBearer("Bearer")).toBeNull();
  });
});
```

- [x] **Step 2: Run, verify it fails**

Run: `npm test -- src/lib/api/token.test.ts`
Expected: FAIL — cannot find module `./token`.

- [x] **Step 3: Implement**

```ts
// src/lib/api/token.ts
import crypto from "node:crypto";

const TOKEN_PREFIX = "ody_";
// "ody_" + 4 chars — enough to recognize a token in the UI without storing it.
const PREFIX_DISPLAY_LEN = 8;

export type GeneratedToken = { raw: string; hash: string; prefix: string };

/** sha256 hex of a raw token. The only form we persist. */
export function hashToken(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

/** Mint a new token. `raw` is shown to the user once and never stored. */
export function generateToken(): GeneratedToken {
  const raw = TOKEN_PREFIX + crypto.randomBytes(32).toString("base64url");
  return { raw, hash: hashToken(raw), prefix: raw.slice(0, PREFIX_DISPLAY_LEN) };
}

/** Extract the credential from an `Authorization: Bearer <x>` header. */
export function parseBearer(header: string | null): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(header);
  return m ? m[1] : null;
}
```

- [x] **Step 4: Run, verify it passes**

Run: `npm test -- src/lib/api/token.test.ts`
Expected: PASS (3 tests).

- [x] **Step 5: Commit**

```bash
git add src/lib/api/token.ts src/lib/api/token.test.ts
git commit -m "feat(api): token generate/hash/parse primitives"
```

---

## Task 3: API response + pagination helpers (`src/lib/api/respond.ts`)

**Files:**
- Create: `src/lib/api/respond.ts`
- Test: `src/lib/api/respond.test.ts`

- [x] **Step 1: Write the failing test**

```ts
// src/lib/api/respond.test.ts
import { describe, it, expect } from "vitest";
import { apiError, rateLimited, parsePage } from "./respond";

describe("apiError", () => {
  it("maps codes to statuses and nests under error", async () => {
    const res = apiError("not_found", "nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found", message: "nope" } });
  });

  it("includes details when given", async () => {
    const res = apiError("validation_error", "bad", { fields: ["name"] });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: "validation_error", message: "bad", details: { fields: ["name"] } },
    });
  });
});

describe("rateLimited", () => {
  it("is 429 with Retry-After", () => {
    const res = rateLimited(7);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("7");
  });
});

describe("parsePage", () => {
  it("defaults limit to 25 and cursor to null", () => {
    expect(parsePage(new URL("https://x/api/v1/events"))).toEqual({ limit: 25, cursor: null });
  });
  it("clamps limit to [1,100] and reads cursor", () => {
    expect(parsePage(new URL("https://x/y?limit=500&cursor=abc")).limit).toBe(100);
    expect(parsePage(new URL("https://x/y?limit=0")).limit).toBe(1);
    expect(parsePage(new URL("https://x/y?limit=10&cursor=abc")).cursor).toBe("abc");
  });
  it("falls back to 25 on non-numeric limit", () => {
    expect(parsePage(new URL("https://x/y?limit=abc")).limit).toBe(25);
  });
});
```

- [x] **Step 2: Run, verify it fails**

Run: `npm test -- src/lib/api/respond.test.ts`
Expected: FAIL — cannot find module `./respond`.

- [x] **Step 3: Implement**

```ts
// src/lib/api/respond.ts
import { NextResponse } from "next/server";

export type ErrorCode =
  | "unauthorized"
  | "not_found"
  | "validation_error"
  | "rate_limited"
  | "conflict";

const STATUS: Record<ErrorCode, number> = {
  unauthorized: 401,
  not_found: 404,
  validation_error: 400,
  rate_limited: 429,
  conflict: 409,
};

export function apiError(
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
) {
  return NextResponse.json(
    { error: { code, message, ...(details ? { details } : {}) } },
    { status: STATUS[code] },
  );
}

/** 429 with a Retry-After hint (seconds). */
export function rateLimited(retryAfterSec: number) {
  return NextResponse.json(
    { error: { code: "rate_limited", message: "rate limit exceeded" } },
    {
      status: 429,
      headers: { "Retry-After": String(retryAfterSec), "X-RateLimit-Remaining": "0" },
    },
  );
}

export type Page = { limit: number; cursor: string | null };

/** Read `?limit=` (default 25, clamped 1..100) and `?cursor=` from a URL. */
export function parsePage(url: URL): Page {
  const rawLimit = Number(url.searchParams.get("limit") ?? 25);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(100, Math.max(1, Math.floor(rawLimit)))
    : 25;
  const cursor = url.searchParams.get("cursor");
  return { limit, cursor: cursor && cursor.length > 0 ? cursor : null };
}
```

- [x] **Step 4: Run, verify it passes**

Run: `npm test -- src/lib/api/respond.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/lib/api/respond.ts src/lib/api/respond.test.ts
git commit -m "feat(api): error + pagination response helpers"
```

---

## Task 4: Sources service + Server Action refactor

This is the worked example of the Approach-A refactor. Later resources follow the same shape.

**Files:**
- Create: `src/lib/services/sources.ts`
- Test: `src/lib/services/sources.ts` via `src/lib/services/sources.test.ts`
- Modify: `src/lib/actions/sources.ts`

- [x] **Step 1: Write the failing test (DB-backed)**

```ts
// src/lib/services/sources.test.ts
import "dotenv/config";
import { describe, it, expect } from "vitest";
import { prisma } from "../prisma";
import { createSource, getSource, listSources, updateSource, deleteSource } from "./sources";

async function makeUser() {
  return prisma.user.create({
    data: { email: `src-svc-${Date.now()}-${Math.random()}@test.local` },
  });
}

describe("sources service", () => {
  it("creates a source, returns a secret-free DTO with a slug", async () => {
    const u = await makeUser();
    const dto = await createSource(u.id, { name: "Stripe", verifyStyle: "stripe", signingSecret: "whsec_123" });
    expect(dto.name).toBe("Stripe");
    expect(dto.verifyStyle).toBe("stripe");
    expect(dto.hasSigningSecret).toBe(true);
    expect(dto.slug).toMatch(/^[a-z0-9_-]+$/);
    expect((dto as Record<string, unknown>).signingSecret).toBeUndefined();
  });

  it("requires a signing secret when verifyStyle is set", async () => {
    const u = await makeUser();
    await expect(createSource(u.id, { name: "x", verifyStyle: "github" })).rejects.toThrow();
  });

  it("lists only the owner's sources and gets by id scoped to owner", async () => {
    const a = await makeUser();
    const b = await makeUser();
    const sa = await createSource(a.id, { name: "A", verifyStyle: "none" });
    await createSource(b.id, { name: "B", verifyStyle: "none" });
    const list = await listSources(a.id, { limit: 25, cursor: null });
    expect(list.data.map((s) => s.id)).toContain(sa.id);
    expect(list.data.every((s) => s.name !== "B")).toBe(true);
    expect(await getSource(b.id, sa.id)).toBeNull(); // cross-owner read denied
  });

  it("updates name and clears verification", async () => {
    const u = await makeUser();
    const s = await createSource(u.id, { name: "A", verifyStyle: "stripe", signingSecret: "whsec_1" });
    const up = await updateSource(u.id, s.id, { name: "B", verifyStyle: "none" });
    expect(up?.name).toBe("B");
    expect(up?.verifyStyle).toBeNull();
    expect(up?.hasSigningSecret).toBe(false);
  });

  it("delete is owner-scoped (no-op for non-owner) ", async () => {
    const a = await makeUser();
    const b = await makeUser();
    const s = await createSource(a.id, { name: "A", verifyStyle: "none" });
    expect(await deleteSource(b.id, s.id)).toBe(false);
    expect(await deleteSource(a.id, s.id)).toBe(true);
    expect(await getSource(a.id, s.id)).toBeNull();
  });
});
```

- [x] **Step 2: Run, verify it fails**

Run: `docker compose up -d && npm test -- src/lib/services/sources.test.ts`
Expected: FAIL — cannot find module `./sources`.

- [x] **Step 3: Implement the service**

```ts
// src/lib/services/sources.ts
import crypto from "node:crypto";
import { z } from "zod";

import { prisma } from "@/lib/prisma";
import { encrypt } from "@/lib/crypto";
import type { Page } from "@/lib/api/respond";

const VERIFY_STYLES = ["none", "stripe", "github", "generic-sha256"] as const;

export const sourceCreateSchema = z
  .object({
    name: z.string().min(1).max(100),
    verifyStyle: z.enum(VERIFY_STYLES).default("none"),
    signingSecret: z.string().optional(),
  })
  .refine(
    (v) => v.verifyStyle === "none" || (v.signingSecret?.trim().length ?? 0) > 0,
    { message: "signing secret is required when verifyStyle is set", path: ["signingSecret"] },
  );

export const sourceUpdateSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    verifyStyle: z.enum(VERIFY_STYLES).optional(),
    signingSecret: z.string().optional(),
    rateLimitPerSec: z.number().int().positive().nullable().optional(),
    rateLimitBurst: z.number().int().positive().nullable().optional(),
  });

export type SourceInput = z.input<typeof sourceCreateSchema>;
export type SourceUpdateInput = z.input<typeof sourceUpdateSchema>;

export type SourceDTO = {
  id: string;
  name: string;
  slug: string;
  verifyStyle: string | null;
  hasSigningSecret: boolean;
  rateLimitPerSec: number | null;
  rateLimitBurst: number | null;
  createdAt: string;
};

type SourceRow = {
  id: string;
  name: string;
  slug: string;
  verifyStyle: string | null;
  signingSecret: string | null;
  rateLimitPerSec: number | null;
  rateLimitBurst: number | null;
  createdAt: Date;
};

function toDTO(s: SourceRow): SourceDTO {
  return {
    id: s.id,
    name: s.name,
    slug: s.slug,
    verifyStyle: s.verifyStyle,
    hasSigningSecret: s.signingSecret != null,
    rateLimitPerSec: s.rateLimitPerSec,
    rateLimitBurst: s.rateLimitBurst,
    createdAt: s.createdAt.toISOString(),
  };
}

function randomSlug(): string {
  return crypto.randomBytes(6).toString("base64url").toLowerCase();
}

export async function createSource(userId: string, input: SourceInput): Promise<SourceDTO> {
  const parsed = sourceCreateSchema.parse(input);
  const created = await prisma.source.create({
    data: {
      userId,
      name: parsed.name,
      slug: randomSlug(),
      verifyStyle: parsed.verifyStyle === "none" ? null : parsed.verifyStyle,
      signingSecret:
        parsed.verifyStyle !== "none" && parsed.signingSecret
          ? encrypt(parsed.signingSecret)
          : null,
    },
  });
  return toDTO(created);
}

export async function listSources(
  userId: string,
  page: Page,
): Promise<{ data: SourceDTO[]; nextCursor: string | null }> {
  const rows = await prisma.source.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: page.limit,
    ...(page.cursor ? { cursor: { id: page.cursor }, skip: 1 } : {}),
  });
  const nextCursor = rows.length === page.limit ? rows[rows.length - 1].id : null;
  return { data: rows.map(toDTO), nextCursor };
}

export async function getSource(userId: string, id: string): Promise<SourceDTO | null> {
  const row = await prisma.source.findFirst({ where: { id, userId } });
  return row ? toDTO(row) : null;
}

export async function updateSource(
  userId: string,
  id: string,
  input: SourceUpdateInput,
): Promise<SourceDTO | null> {
  const parsed = sourceUpdateSchema.parse(input);
  const existing = await prisma.source.findFirst({ where: { id, userId } });
  if (!existing) return null;

  const data: Record<string, unknown> = {};
  if (parsed.name !== undefined) data.name = parsed.name;
  if (parsed.rateLimitPerSec !== undefined) data.rateLimitPerSec = parsed.rateLimitPerSec;
  if (parsed.rateLimitBurst !== undefined) data.rateLimitBurst = parsed.rateLimitBurst;
  if (parsed.verifyStyle !== undefined) {
    if (parsed.verifyStyle === "none") {
      data.verifyStyle = null;
      data.signingSecret = null;
    } else {
      if (!parsed.signingSecret?.trim()) {
        throw new z.ZodError([
          { code: "custom", path: ["signingSecret"], message: "signing secret is required when verifyStyle is set" },
        ]);
      }
      data.verifyStyle = parsed.verifyStyle;
      data.signingSecret = encrypt(parsed.signingSecret);
    }
  }

  const updated = await prisma.source.update({ where: { id }, data });
  return toDTO(updated);
}

export async function deleteSource(userId: string, id: string): Promise<boolean> {
  const res = await prisma.source.deleteMany({ where: { id, userId } });
  return res.count > 0;
}
```

- [x] **Step 4: Run, verify it passes**

Run: `npm test -- src/lib/services/sources.test.ts`
Expected: PASS (5 tests).

- [x] **Step 5: Refactor the Server Action to call the service**

Replace `src/lib/actions/sources.ts` with:

```ts
"use server";

import { revalidatePath } from "next/cache";

import { auth } from "@/auth";
import { createSource, deleteSource } from "@/lib/services/sources";

async function requireUserId(): Promise<string> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("unauthorized");
  return session.user.id;
}

export async function createSource(formData: FormData) {
  const userId = await requireUserId();
  await createSourceSvc(userId, {
    name: String(formData.get("name") ?? ""),
    verifyStyle: (String(formData.get("verifyStyle") ?? "none")) as
      | "none" | "stripe" | "github" | "generic-sha256",
    signingSecret: formData.get("signingSecret")
      ? String(formData.get("signingSecret"))
      : undefined,
  });
  revalidatePath("/sources");
}

export async function deleteSourceAction(formData: FormData) {
  const userId = await requireUserId();
  await deleteSource(userId, String(formData.get("id")));
  revalidatePath("/sources");
}
```

> ⚠️ The action and the service can't both be named `createSource` in one file. Import the service under an alias and keep the **exported action names the existing UI imports unchanged**. Adjust the import to:
> ```ts
> import { createSource as createSourceSvc, deleteSource } from "@/lib/services/sources";
> ```
> Check the existing export names the UI relies on before renaming. The old file exported `createSource(formData)` and `deleteSource(formData)`. To avoid touching call sites, keep those two exported names: alias the service functions (`createSourceSvc`, `deleteSourceSvc`) and have the actions keep the names `createSource` / `deleteSource`.

Corrected action file:

```ts
"use server";

import { revalidatePath } from "next/cache";

import { auth } from "@/auth";
import {
  createSource as createSourceSvc,
  deleteSource as deleteSourceSvc,
} from "@/lib/services/sources";

async function requireUserId(): Promise<string> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("unauthorized");
  return session.user.id;
}

export async function createSource(formData: FormData) {
  const userId = await requireUserId();
  await createSourceSvc(userId, {
    name: String(formData.get("name") ?? ""),
    verifyStyle: String(formData.get("verifyStyle") ?? "none") as
      | "none" | "stripe" | "github" | "generic-sha256",
    signingSecret: formData.get("signingSecret")
      ? String(formData.get("signingSecret"))
      : undefined,
  });
  revalidatePath("/sources");
}

export async function deleteSource(formData: FormData) {
  const userId = await requireUserId();
  await deleteSourceSvc(userId, String(formData.get("id")));
  revalidatePath("/sources");
}
```

- [x] **Step 6: Verify the build + the UI still type-checks**

Run: `npm run build`
Expected: build succeeds (confirms the action signatures the `/sources` page imports are unchanged).

- [x] **Step 7: Commit**

```bash
git add src/lib/services/sources.ts src/lib/services/sources.test.ts src/lib/actions/sources.ts
git commit -m "feat(api): sources service layer; refactor source actions to wrappers"
```

---

## Task 5: Destinations service + Server Action refactor

The destination logic includes SSRF checks, header parsing, and two write-only secrets (`headersEnc`, `outboundSecretEnc`). Move the `parseHeaders`, `HEADER_NAME_RE`, `HEADER_VALUE_RE`, and SSRF handling into the service so both edges share them.

**Files:**
- Create: `src/lib/services/destinations.ts` + `src/lib/services/destinations.test.ts`
- Modify: `src/lib/actions/destinations.ts`

- [x] **Step 1: Write the failing test (DB-backed)**

```ts
// src/lib/services/destinations.test.ts
import "dotenv/config";
import { describe, it, expect } from "vitest";
import { prisma } from "../prisma";
import {
  createDestination,
  getDestination,
  listDestinations,
  updateDestination,
  deleteDestination,
} from "./destinations";

async function makeUser() {
  return prisma.user.create({
    data: { email: `dst-svc-${Date.now()}-${Math.random()}@test.local` },
  });
}

describe("destinations service", () => {
  it("creates with headers + outbound secret, returns secret-free DTO", async () => {
    const u = await makeUser();
    const dto = await createDestination(u.id, {
      name: "hook",
      url: "https://example.test/hook",
      headers: "X-Api-Key: abc",
      outboundSecret: "supersecretsupersecret",
    });
    expect(dto.url).toBe("https://example.test/hook");
    expect(dto.hasHeaders).toBe(true);
    expect(dto.hasOutboundSecret).toBe(true);
    expect(dto.enabled).toBe(true);
    expect((dto as Record<string, unknown>).headersEnc).toBeUndefined();
    expect((dto as Record<string, unknown>).outboundSecretEnc).toBeUndefined();
  });

  it("rejects an SSRF-unsafe url", async () => {
    const u = await makeUser();
    await expect(
      createDestination(u.id, { name: "x", url: "http://169.254.169.254/" }),
    ).rejects.toThrow();
  });

  it("rejects malformed header lines", async () => {
    const u = await makeUser();
    await expect(
      createDestination(u.id, { name: "x", url: "https://example.test/", headers: "no-colon" }),
    ).rejects.toThrow();
  });

  it("get/list/delete are owner-scoped", async () => {
    const a = await makeUser();
    const b = await makeUser();
    const d = await createDestination(a.id, { name: "A", url: "https://example.test/" });
    expect(await getDestination(b.id, d.id)).toBeNull();
    expect((await listDestinations(a.id, { limit: 25, cursor: null })).data.some((x) => x.id === d.id)).toBe(true);
    expect(await deleteDestination(b.id, d.id)).toBe(false);
    expect(await deleteDestination(a.id, d.id)).toBe(true);
  });

  it("updates timeout and url", async () => {
    const u = await makeUser();
    const d = await createDestination(u.id, { name: "A", url: "https://example.test/" });
    const up = await updateDestination(u.id, d.id, { timeoutMs: 5000, url: "https://example.test/other" });
    expect(up?.timeoutMs).toBe(5000);
    expect(up?.url).toBe("https://example.test/other");
  });
});
```

- [x] **Step 2: Run, verify it fails**

Run: `npm test -- src/lib/services/destinations.test.ts`
Expected: FAIL — cannot find module `./destinations`.

- [x] **Step 3: Implement the service**

```ts
// src/lib/services/destinations.ts
import { z } from "zod";

import { prisma } from "@/lib/prisma";
import { encrypt, encryptJson } from "@/lib/crypto";
import { assertSafeUrl, SsrfError } from "@/lib/ssrf";
import type { Page } from "@/lib/api/respond";

// RFC 7230 token chars for header names.
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// Visible ASCII + space/tab; no CR/LF (prevents header smuggling at delivery).
const HEADER_VALUE_RE = /^[\t\x20-\x7E]*$/;

export function parseHeaders(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const cleaned = line.replace(/\r$/, "");
    if (cleaned.trim() === "") continue;
    const idx = cleaned.indexOf(":");
    if (idx === -1) throw new Error(`Invalid header line (missing ':'): ${cleaned}`);
    const key = cleaned.slice(0, idx).trim();
    const value = cleaned.slice(idx + 1).trim();
    if (!key) continue;
    if (!HEADER_NAME_RE.test(key)) throw new Error(`Invalid header name: ${JSON.stringify(key)}`);
    if (!HEADER_VALUE_RE.test(value)) {
      throw new Error(`Invalid header value for ${key} (control chars not allowed)`);
    }
    out[key] = value;
  }
  return out;
}

export const destinationCreateSchema = z.object({
  name: z.string().min(1).max(100),
  url: z.string().url(),
  timeoutMs: z.coerce.number().int().min(1000).max(60_000).default(10_000),
  headers: z.string().optional(), // "Key: Value" per line
  outboundSecret: z
    .string()
    .min(16, "Outbound signing secret must be at least 16 characters")
    .max(256)
    .optional()
    .or(z.literal("")),
});

export const destinationUpdateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  url: z.string().url().optional(),
  timeoutMs: z.coerce.number().int().min(1000).max(60_000).optional(),
  headers: z.string().optional(),
  outboundSecret: z.string().min(16).max(256).optional().or(z.literal("")),
  enabled: z.boolean().optional(),
});

export type DestinationInput = z.input<typeof destinationCreateSchema>;
export type DestinationUpdateInput = z.input<typeof destinationUpdateSchema>;

export type DestinationDTO = {
  id: string;
  name: string;
  url: string;
  timeoutMs: number;
  enabled: boolean;
  hasHeaders: boolean;
  hasOutboundSecret: boolean;
  consecutiveFailures: number;
  autoDisabledAt: string | null;
  createdAt: string;
};

type DestinationRow = {
  id: string;
  name: string;
  url: string;
  timeoutMs: number;
  enabled: boolean;
  headersEnc: string | null;
  outboundSecretEnc: string | null;
  consecutiveFailures: number;
  autoDisabledAt: Date | null;
  createdAt: Date;
};

function toDTO(d: DestinationRow): DestinationDTO {
  return {
    id: d.id,
    name: d.name,
    url: d.url,
    timeoutMs: d.timeoutMs,
    enabled: d.enabled,
    hasHeaders: d.headersEnc != null,
    hasOutboundSecret: d.outboundSecretEnc != null,
    consecutiveFailures: d.consecutiveFailures,
    autoDisabledAt: d.autoDisabledAt ? d.autoDisabledAt.toISOString() : null,
    createdAt: d.createdAt.toISOString(),
  };
}

async function assertUrlSafe(url: string): Promise<void> {
  try {
    await assertSafeUrl(url);
  } catch (err) {
    if (err instanceof SsrfError) throw new Error(`Destination URL rejected: ${err.message}`);
    throw err;
  }
}

export async function createDestination(
  userId: string,
  input: DestinationInput,
): Promise<DestinationDTO> {
  const parsed = destinationCreateSchema.parse(input);
  const headers = parseHeaders(parsed.headers);
  const hasHeaders = Object.keys(headers).length > 0;
  const outboundSecret = parsed.outboundSecret?.trim() || null;
  await assertUrlSafe(parsed.url);

  const created = await prisma.destination.create({
    data: {
      userId,
      name: parsed.name,
      url: parsed.url,
      timeoutMs: parsed.timeoutMs,
      headersEnc: hasHeaders ? encryptJson(headers) : null,
      outboundSecretEnc: outboundSecret ? encrypt(outboundSecret) : null,
    },
  });
  return toDTO(created);
}

export async function listDestinations(
  userId: string,
  page: Page,
): Promise<{ data: DestinationDTO[]; nextCursor: string | null }> {
  const rows = await prisma.destination.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: page.limit,
    ...(page.cursor ? { cursor: { id: page.cursor }, skip: 1 } : {}),
  });
  const nextCursor = rows.length === page.limit ? rows[rows.length - 1].id : null;
  return { data: rows.map(toDTO), nextCursor };
}

export async function getDestination(userId: string, id: string): Promise<DestinationDTO | null> {
  const row = await prisma.destination.findFirst({ where: { id, userId } });
  return row ? toDTO(row) : null;
}

export async function updateDestination(
  userId: string,
  id: string,
  input: DestinationUpdateInput,
): Promise<DestinationDTO | null> {
  const parsed = destinationUpdateSchema.parse(input);
  const existing = await prisma.destination.findFirst({ where: { id, userId } });
  if (!existing) return null;

  const data: Record<string, unknown> = {};
  if (parsed.name !== undefined) data.name = parsed.name;
  if (parsed.timeoutMs !== undefined) data.timeoutMs = parsed.timeoutMs;
  if (parsed.url !== undefined) {
    await assertUrlSafe(parsed.url);
    data.url = parsed.url;
  }
  if (parsed.headers !== undefined) {
    const headers = parseHeaders(parsed.headers);
    data.headersEnc = Object.keys(headers).length > 0 ? encryptJson(headers) : null;
  }
  if (parsed.outboundSecret !== undefined) {
    const s = parsed.outboundSecret.trim();
    data.outboundSecretEnc = s ? encrypt(s) : null;
  }
  if (parsed.enabled !== undefined) {
    data.enabled = parsed.enabled;
    if (parsed.enabled) {
      // Resuming clears breaker state, matching toggleDestinationEnabled.
      data.consecutiveFailures = 0;
      data.autoDisabledAt = null;
      data.autoDisabledReason = null;
    }
  }

  const updated = await prisma.destination.update({ where: { id }, data });
  return toDTO(updated);
}

export async function deleteDestination(userId: string, id: string): Promise<boolean> {
  const res = await prisma.destination.deleteMany({ where: { id, userId } });
  return res.count > 0;
}
```

- [x] **Step 4: Run, verify it passes**

Run: `npm test -- src/lib/services/destinations.test.ts`
Expected: PASS (5 tests).

- [x] **Step 5: Refactor the Server Action**

Rewrite `src/lib/actions/destinations.ts` so `createDestination` and `deleteDestination` delegate to the service (aliased), `parseHeaders` is imported from the service (delete the local copy + the two regexes), and `toggleDestinationEnabled` stays as-is (it's UI-specific). Keep the existing exported action names:

```ts
"use server";

import { revalidatePath } from "next/cache";

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import {
  createDestination as createDestinationSvc,
  deleteDestination as deleteDestinationSvc,
} from "@/lib/services/destinations";

async function requireUserId(): Promise<string> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("unauthorized");
  return session.user.id;
}

export async function createDestination(formData: FormData) {
  const userId = await requireUserId();
  await createDestinationSvc(userId, {
    name: String(formData.get("name") ?? ""),
    url: String(formData.get("url") ?? ""),
    timeoutMs: formData.get("timeoutMs") ? Number(formData.get("timeoutMs")) : 10_000,
    headers: String(formData.get("headers") ?? ""),
    outboundSecret: String(formData.get("outboundSecret") ?? ""),
  });
  revalidatePath("/destinations");
}

export async function deleteDestination(formData: FormData) {
  const userId = await requireUserId();
  await deleteDestinationSvc(userId, String(formData.get("id")));
  revalidatePath("/destinations");
}

// Unchanged: UI-only pause/resume with breaker reset.
export async function toggleDestinationEnabled(formData: FormData) {
  const userId = await requireUserId();
  const id = String(formData.get("id"));
  const existing = await prisma.destination.findFirst({
    where: { id, userId },
    select: { enabled: true },
  });
  if (!existing) throw new Error("not found");
  const nextEnabled = !existing.enabled;
  const data = nextEnabled
    ? { enabled: true, consecutiveFailures: 0, autoDisabledAt: null, autoDisabledReason: null }
    : { enabled: false };
  await prisma.destination.update({ where: { id }, data });
  revalidatePath("/destinations");
}
```

- [x] **Step 6: Verify build**

Run: `npm run build`
Expected: succeeds.

- [x] **Step 7: Commit**

```bash
git add src/lib/services/destinations.ts src/lib/services/destinations.test.ts src/lib/actions/destinations.ts
git commit -m "feat(api): destinations service layer; refactor destination actions"
```

---

## Task 6: Routes service + Server Action refactor

The route resource has a compound unique `(sourceId, destinationId)` and must verify the caller owns BOTH the source and destination. The API supports create / list / get / update (`enabled`) / delete. The UI's `toggleRoute` stays.

**Files:**
- Create: `src/lib/services/routes.ts` + `src/lib/services/routes.test.ts`
- Modify: `src/lib/actions/routes.ts`

- [x] **Step 1: Write the failing test (DB-backed)**

```ts
// src/lib/services/routes.test.ts
import "dotenv/config";
import { describe, it, expect } from "vitest";
import { prisma } from "../prisma";
import { createRoute, getRoute, listRoutes, updateRoute, deleteRoute } from "./routes";

async function makeUserWithSourceAndDest() {
  const user = await prisma.user.create({
    data: { email: `rt-svc-${Date.now()}-${Math.random()}@test.local` },
  });
  const source = await prisma.source.create({
    data: { userId: user.id, name: "s", slug: `rt-${Date.now()}-${Math.random().toString(36).slice(2)}` },
  });
  const dest = await prisma.destination.create({
    data: { userId: user.id, name: "d", url: "https://example.test/" },
  });
  return { user, source, dest };
}

describe("routes service", () => {
  it("creates a route between owned source and destination", async () => {
    const { user, source, dest } = await makeUserWithSourceAndDest();
    const dto = await createRoute(user.id, { sourceId: source.id, destinationId: dest.id });
    expect(dto.sourceId).toBe(source.id);
    expect(dto.destinationId).toBe(dest.id);
    expect(dto.enabled).toBe(true);
  });

  it("rejects creating a route to a destination the caller doesn't own", async () => {
    const a = await makeUserWithSourceAndDest();
    const b = await makeUserWithSourceAndDest();
    await expect(
      createRoute(a.user.id, { sourceId: a.source.id, destinationId: b.dest.id }),
    ).rejects.toThrow(/not found/i);
  });

  it("rejects a duplicate (source,destination) route with a conflict", async () => {
    const { user, source, dest } = await makeUserWithSourceAndDest();
    await createRoute(user.id, { sourceId: source.id, destinationId: dest.id });
    await expect(
      createRoute(user.id, { sourceId: source.id, destinationId: dest.id }),
    ).rejects.toThrow(/conflict/i);
  });

  it("updates enabled and deletes, owner-scoped", async () => {
    const { user, source, dest } = await makeUserWithSourceAndDest();
    const r = await createRoute(user.id, { sourceId: source.id, destinationId: dest.id });
    const up = await updateRoute(user.id, r.id, { enabled: false });
    expect(up?.enabled).toBe(false);
    expect(await getRoute(user.id, r.id)).not.toBeNull();
    expect(await deleteRoute(user.id, r.id)).toBe(true);
  });

  it("lists routes for owned sources only", async () => {
    const a = await makeUserWithSourceAndDest();
    await createRoute(a.user.id, { sourceId: a.source.id, destinationId: a.dest.id });
    const list = await listRoutes(a.user.id, { limit: 25, cursor: null });
    expect(list.data.length).toBeGreaterThanOrEqual(1);
    expect(list.data.every((r) => r.sourceId === a.source.id)).toBe(true);
  });
});
```

- [x] **Step 2: Run, verify it fails**

Run: `npm test -- src/lib/services/routes.test.ts`
Expected: FAIL — cannot find module `./routes`.

- [x] **Step 3: Implement the service**

```ts
// src/lib/services/routes.ts
import { z } from "zod";

import { prisma } from "@/lib/prisma";
import type { Page } from "@/lib/api/respond";

export const routeCreateSchema = z.object({
  sourceId: z.string().min(1),
  destinationId: z.string().min(1),
  enabled: z.boolean().default(true),
});

export const routeUpdateSchema = z.object({
  enabled: z.boolean().optional(),
});

export type RouteInput = z.input<typeof routeCreateSchema>;
export type RouteUpdateInput = z.input<typeof routeUpdateSchema>;

export type RouteDTO = {
  id: string;
  sourceId: string;
  destinationId: string;
  enabled: boolean;
  hasFilter: boolean;
  createdAt: string;
};

type RouteRow = {
  id: string;
  sourceId: string;
  destinationId: string;
  enabled: boolean;
  filterAst: unknown;
  createdAt: Date;
};

function toDTO(r: RouteRow): RouteDTO {
  return {
    id: r.id,
    sourceId: r.sourceId,
    destinationId: r.destinationId,
    enabled: r.enabled,
    hasFilter: r.filterAst != null,
    createdAt: r.createdAt.toISOString(),
  };
}

/** Thrown when a (source,destination) route already exists. Handlers map to 409. */
export class RouteConflictError extends Error {}

export async function createRoute(userId: string, input: RouteInput): Promise<RouteDTO> {
  const parsed = routeCreateSchema.parse(input);
  // Both ends must belong to the caller.
  const [source, destination] = await Promise.all([
    prisma.source.findFirst({ where: { id: parsed.sourceId, userId } }),
    prisma.destination.findFirst({ where: { id: parsed.destinationId, userId } }),
  ]);
  if (!source || !destination) throw new Error("not found");

  const existing = await prisma.route.findUnique({
    where: { sourceId_destinationId: { sourceId: parsed.sourceId, destinationId: parsed.destinationId } },
  });
  if (existing) throw new RouteConflictError("conflict: route already exists");

  const created = await prisma.route.create({
    data: { sourceId: parsed.sourceId, destinationId: parsed.destinationId, enabled: parsed.enabled },
  });
  return toDTO(created);
}

export async function listRoutes(
  userId: string,
  page: Page,
): Promise<{ data: RouteDTO[]; nextCursor: string | null }> {
  const rows = await prisma.route.findMany({
    where: { source: { userId } },
    orderBy: { createdAt: "desc" },
    take: page.limit,
    ...(page.cursor ? { cursor: { id: page.cursor }, skip: 1 } : {}),
  });
  const nextCursor = rows.length === page.limit ? rows[rows.length - 1].id : null;
  return { data: rows.map(toDTO), nextCursor };
}

export async function getRoute(userId: string, id: string): Promise<RouteDTO | null> {
  const row = await prisma.route.findFirst({ where: { id, source: { userId } } });
  return row ? toDTO(row) : null;
}

export async function updateRoute(
  userId: string,
  id: string,
  input: RouteUpdateInput,
): Promise<RouteDTO | null> {
  const parsed = routeUpdateSchema.parse(input);
  const existing = await prisma.route.findFirst({ where: { id, source: { userId } } });
  if (!existing) return null;
  const data: Record<string, unknown> = {};
  if (parsed.enabled !== undefined) data.enabled = parsed.enabled;
  const updated = await prisma.route.update({ where: { id }, data });
  return toDTO(updated);
}

export async function deleteRoute(userId: string, id: string): Promise<boolean> {
  const existing = await prisma.route.findFirst({ where: { id, source: { userId } }, select: { id: true } });
  if (!existing) return false;
  await prisma.route.delete({ where: { id } });
  return true;
}
```

- [x] **Step 4: Run, verify it passes**

Run: `npm test -- src/lib/services/routes.test.ts`
Expected: PASS (5 tests).

- [x] **Step 5: Refactor `toggleRoute` to reuse ownership logic (optional, low-risk)**

Leave `src/lib/actions/routes.ts`'s `toggleRoute` functionally as-is — it has create-or-flip semantics specific to the UI grid that don't map onto the service's create/update split. Just confirm it still compiles. No change required beyond verifying the build in the next step.

- [x] **Step 6: Verify build**

Run: `npm run build`
Expected: succeeds.

- [x] **Step 7: Commit**

```bash
git add src/lib/services/routes.ts src/lib/services/routes.test.ts
git commit -m "feat(api): routes service layer (create/list/get/update/delete)"
```

---

## Task 7: Events read service

Events and deliveries are read-only via the API. Events list is paginated by `(receivedAt desc, id)`; get includes deliveries (delivery `responseBodySnippet`/`lastError` are operational data, fine to return; no encrypted secrets live on Event/Delivery).

**Files:**
- Create: `src/lib/services/events.ts` + `src/lib/services/events.test.ts`

- [x] **Step 1: Write the failing test (DB-backed)**

```ts
// src/lib/services/events.test.ts
import "dotenv/config";
import { describe, it, expect } from "vitest";
import { prisma } from "../prisma";
import { listEvents, getEvent } from "./events";

async function setup() {
  const user = await prisma.user.create({
    data: { email: `ev-svc-${Date.now()}-${Math.random()}@test.local` },
  });
  const source = await prisma.source.create({
    data: { userId: user.id, name: "s", slug: `ev-${Date.now()}-${Math.random().toString(36).slice(2)}` },
  });
  return { user, source };
}

describe("events service", () => {
  it("lists owner's events newest-first with a working cursor", async () => {
    const { user, source } = await setup();
    for (let i = 0; i < 3; i++) {
      await prisma.event.create({
        data: { sourceId: source.id, method: "POST", headersJson: {}, bodyRaw: `{"i":${i}}`, receivedAt: new Date(Date.now() + i * 1000) },
      });
    }
    const page1 = await listEvents(user.id, { limit: 2, cursor: null });
    expect(page1.data.length).toBe(2);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await listEvents(user.id, { limit: 2, cursor: page1.nextCursor });
    expect(page2.data.length).toBe(1);
    // No overlap between pages.
    const ids = new Set(page1.data.map((e) => e.id));
    expect(page2.data.every((e) => !ids.has(e.id))).toBe(true);
  });

  it("get returns the event with deliveries, owner-scoped", async () => {
    const { user, source } = await setup();
    const ev = await prisma.event.create({
      data: { sourceId: source.id, method: "POST", headersJson: {}, bodyRaw: "{}" },
    });
    const got = await getEvent(user.id, ev.id);
    expect(got?.id).toBe(ev.id);
    expect(Array.isArray(got?.deliveries)).toBe(true);

    const other = await prisma.user.create({ data: { email: `ev-other-${Date.now()}-${Math.random()}@test.local` } });
    expect(await getEvent(other.id, ev.id)).toBeNull();
  });
});
```

- [x] **Step 2: Run, verify it fails**

Run: `npm test -- src/lib/services/events.test.ts`
Expected: FAIL — cannot find module `./events`.

- [x] **Step 3: Implement the service**

```ts
// src/lib/services/events.ts
import { prisma } from "@/lib/prisma";
import type { Page } from "@/lib/api/respond";

export type EventDTO = {
  id: string;
  sourceId: string;
  method: string;
  receivedAt: string;
  remoteIp: string | null;
  idempotencyKey: string | null;
};

export type DeliveryDTO = {
  id: string;
  destinationId: string;
  status: string;
  attemptCount: number;
  responseCode: number | null;
  lastError: string | null;
  deliveredAt: string | null;
  createdAt: string;
};

export type EventDetailDTO = EventDTO & { bodyRaw: string; deliveries: DeliveryDTO[] };

type EventRow = {
  id: string;
  sourceId: string;
  method: string;
  receivedAt: Date;
  remoteIp: string | null;
  idempotencyKey: string | null;
};

function toDTO(e: EventRow): EventDTO {
  return {
    id: e.id,
    sourceId: e.sourceId,
    method: e.method,
    receivedAt: e.receivedAt.toISOString(),
    remoteIp: e.remoteIp,
    idempotencyKey: e.idempotencyKey,
  };
}

export async function listEvents(
  userId: string,
  page: Page,
): Promise<{ data: EventDTO[]; nextCursor: string | null }> {
  const rows = await prisma.event.findMany({
    where: { source: { userId } },
    orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
    take: page.limit,
    ...(page.cursor ? { cursor: { id: page.cursor }, skip: 1 } : {}),
  });
  const nextCursor = rows.length === page.limit ? rows[rows.length - 1].id : null;
  return { data: rows.map(toDTO), nextCursor };
}

export async function getEvent(userId: string, id: string): Promise<EventDetailDTO | null> {
  const row = await prisma.event.findFirst({
    where: { id, source: { userId } },
    include: { deliveries: { orderBy: { createdAt: "desc" } } },
  });
  if (!row) return null;
  return {
    ...toDTO(row),
    bodyRaw: row.bodyRaw,
    deliveries: row.deliveries.map((d) => ({
      id: d.id,
      destinationId: d.destinationId,
      status: d.status,
      attemptCount: d.attemptCount,
      responseCode: d.responseCode,
      lastError: d.lastError,
      deliveredAt: d.deliveredAt ? d.deliveredAt.toISOString() : null,
      createdAt: d.createdAt.toISOString(),
    })),
  };
}
```

- [x] **Step 4: Run, verify it passes**

Run: `npm test -- src/lib/services/events.test.ts`
Expected: PASS (2 tests).

- [x] **Step 5: Commit**

```bash
git add src/lib/services/events.ts src/lib/services/events.test.ts
git commit -m "feat(api): events read service (list + get with deliveries)"
```

---

## Task 8: API rate limiter + auth helper

**Files:**
- Modify: `src/lib/ratelimit.ts`
- Create: `src/lib/api/authenticate.ts`
- Test: `src/lib/api/authenticate.test.ts`

- [x] **Step 1: Add the API rate-limit config + checker to `ratelimit.ts`**

Append to `src/lib/ratelimit.ts` (it already has the private `consumeToken`):

```ts
/**
 * Per-API-token rate limit for the public REST API. Keyed on the token id so a
 * single runaway script can't saturate the API. Override via
 * API_RATE_LIMIT_PER_SEC / API_RATE_LIMIT_BURST.
 */
export function defaultApiConfig(): RateLimitConfig {
  const refill = Number(process.env.API_RATE_LIMIT_PER_SEC ?? 10);
  const burst = Number(process.env.API_RATE_LIMIT_BURST ?? 30);
  return {
    refillPerSec: Number.isFinite(refill) && refill > 0 ? refill : 10,
    capacity: Number.isFinite(burst) && burst > 0 ? burst : 30,
  };
}

export async function checkApiRateLimit(
  tokenId: string,
  cfg: RateLimitConfig = defaultApiConfig(),
): Promise<RateLimitResult> {
  return consumeToken(`rl:api:${tokenId}`, cfg);
}
```

- [x] **Step 2: Write the failing auth test (DB-backed)**

```ts
// src/lib/api/authenticate.test.ts
import "dotenv/config";
import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/prisma";
import { generateToken } from "./token";
import { authenticateApiToken } from "./authenticate";

async function makeUser() {
  return prisma.user.create({ data: { email: `auth-${Date.now()}-${Math.random()}@test.local` } });
}

function req(authHeader?: string): Request {
  return new Request("https://x/api/v1/sources", {
    headers: authHeader ? { authorization: authHeader } : {},
  });
}

describe("authenticateApiToken", () => {
  it("returns userId for a valid token", async () => {
    const u = await makeUser();
    const t = generateToken();
    await prisma.apiToken.create({ data: { userId: u.id, name: "t", tokenHash: t.hash, prefix: t.prefix } });
    const res = await authenticateApiToken(req(`Bearer ${t.raw}`));
    expect(res?.userId).toBe(u.id);
  });

  it("returns null for missing, malformed, unknown, and revoked tokens", async () => {
    expect(await authenticateApiToken(req())).toBeNull();
    expect(await authenticateApiToken(req("Bearer notody"))).toBeNull();
    expect(await authenticateApiToken(req("Bearer ody_unknown"))).toBeNull();

    const u = await makeUser();
    const t = generateToken();
    await prisma.apiToken.create({
      data: { userId: u.id, name: "t", tokenHash: t.hash, prefix: t.prefix, revokedAt: new Date() },
    });
    expect(await authenticateApiToken(req(`Bearer ${t.raw}`))).toBeNull();
  });
});
```

- [x] **Step 3: Run, verify it fails**

Run: `npm test -- src/lib/api/authenticate.test.ts`
Expected: FAIL — cannot find module `./authenticate`.

- [x] **Step 4: Implement the auth helper**

```ts
// src/lib/api/authenticate.ts
import { prisma } from "@/lib/prisma";
import { hashToken, parseBearer } from "./token";

export type ApiAuth = { userId: string; tokenId: string };

/**
 * Resolve an `Authorization: Bearer ody_…` header to its owner. Returns null
 * for missing/malformed/unknown/revoked tokens — callers respond 401.
 */
export async function authenticateApiToken(req: Request): Promise<ApiAuth | null> {
  const raw = parseBearer(req.headers.get("authorization"));
  if (!raw || !raw.startsWith("ody_")) return null;

  const token = await prisma.apiToken.findUnique({ where: { tokenHash: hashToken(raw) } });
  if (!token || token.revokedAt) return null;

  // Fire-and-forget last-used bump; never block or fail the request on it.
  prisma.apiToken
    .update({ where: { id: token.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {});

  return { userId: token.userId, tokenId: token.id };
}
```

- [x] **Step 5: Run, verify it passes**

Run: `npm test -- src/lib/api/authenticate.test.ts`
Expected: PASS (2 tests).

- [x] **Step 6: Commit**

```bash
git add src/lib/ratelimit.ts src/lib/api/authenticate.ts src/lib/api/authenticate.test.ts
git commit -m "feat(api): bearer-token auth helper + per-token rate limit"
```

---

## Task 9: A shared handler guard (auth + rate limit) — `withApiAuth`

To keep the eight handlers DRY, wrap auth + rate-limiting once.

**Files:**
- Create: `src/lib/api/handler.ts`

- [x] **Step 1: Implement the wrapper**

```ts
// src/lib/api/handler.ts
import { z } from "zod";

import { authenticateApiToken, type ApiAuth } from "./authenticate";
import { checkApiRateLimit } from "@/lib/ratelimit";
import { apiError, rateLimited, type ErrorCode } from "./respond";
import { RouteConflictError } from "@/lib/services/routes";

type Handler = (req: Request, auth: ApiAuth, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

/**
 * Authenticate, rate-limit, then run `fn`. Centralizes 401/429 and maps
 * thrown ZodError → 400 validation_error, "not found" → 404,
 * RouteConflictError → 409, everything else → rethrow (500 via framework).
 */
export function withApiAuth(fn: Handler) {
  return async (req: Request, ctx: { params: Promise<Record<string, string>> }): Promise<Response> => {
    const auth = await authenticateApiToken(req);
    if (!auth) return apiError("unauthorized", "missing or invalid API token");

    try {
      const rl = await checkApiRateLimit(auth.tokenId);
      if (!rl.allowed) return rateLimited(Math.max(1, Math.ceil(rl.retryAfterMs / 1000)));
    } catch (err) {
      // Fail open on Redis errors, matching ingest/replay behavior.
      console.error("[api] rate limiter error (failing open):", err);
    }

    try {
      return await fn(req, auth, ctx);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return apiError("validation_error", "request validation failed", { issues: err.issues });
      }
      if (err instanceof RouteConflictError) {
        return apiError("conflict", err.message);
      }
      if (err instanceof Error && /not found/i.test(err.message)) {
        return apiError("not_found", err.message);
      }
      throw err;
    }
  };
}

/** Parse a JSON request body, throwing a ZodError-friendly message on failure. */
export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new z.ZodError([{ code: "custom", path: [], message: "invalid JSON body" }]);
  }
}

export { apiError };
export type { ErrorCode };
```

- [x] **Step 2: Verify it type-checks**

Run: `npm run build`
Expected: succeeds (no handlers use it yet; this just confirms imports resolve).

- [x] **Step 3: Commit**

```bash
git add src/lib/api/handler.ts
git commit -m "feat(api): withApiAuth wrapper (auth + rate limit + error mapping)"
```

---

## Task 10: Sources route handlers + handler test

**Files:**
- Create: `src/app/api/v1/sources/route.ts`
- Create: `src/app/api/v1/sources/[id]/route.ts`
- Test: `src/app/api/v1/sources/route.test.ts`

- [x] **Step 1: Implement the collection handler**

```ts
// src/app/api/v1/sources/route.ts
import { NextResponse } from "next/server";

import { withApiAuth, readJson } from "@/lib/api/handler";
import { parsePage } from "@/lib/api/respond";
import { createSource, listSources } from "@/lib/services/sources";

export const runtime = "nodejs";

export const GET = withApiAuth(async (req, auth) => {
  const page = parsePage(new URL(req.url));
  const result = await listSources(auth.userId, page);
  return NextResponse.json(result);
});

export const POST = withApiAuth(async (req, auth) => {
  const body = await readJson(req);
  const dto = await createSource(auth.userId, body as never);
  return NextResponse.json(dto, { status: 201 });
});
```

- [x] **Step 2: Implement the item handler**

```ts
// src/app/api/v1/sources/[id]/route.ts
import { NextResponse } from "next/server";

import { withApiAuth, readJson, apiError } from "@/lib/api/handler";
import { getSource, updateSource, deleteSource } from "@/lib/services/sources";

export const runtime = "nodejs";

export const GET = withApiAuth(async (_req, auth, ctx) => {
  const { id } = await ctx.params;
  const dto = await getSource(auth.userId, id);
  return dto ? NextResponse.json(dto) : apiError("not_found", "source not found");
});

export const PATCH = withApiAuth(async (req, auth, ctx) => {
  const { id } = await ctx.params;
  const body = await readJson(req);
  const dto = await updateSource(auth.userId, id, body as never);
  return dto ? NextResponse.json(dto) : apiError("not_found", "source not found");
});

export const DELETE = withApiAuth(async (_req, auth, ctx) => {
  const { id } = await ctx.params;
  const ok = await deleteSource(auth.userId, id);
  return ok ? new NextResponse(null, { status: 204 }) : apiError("not_found", "source not found");
});
```

- [x] **Step 3: Write the handler test (DB-backed, end-to-end through auth)**

```ts
// src/app/api/v1/sources/route.test.ts
import "dotenv/config";
import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/prisma";
import { generateToken } from "@/lib/api/token";
import { GET, POST } from "./route";
import { GET as GET_ONE, PATCH, DELETE } from "./[id]/route";

async function makeUserWithToken() {
  const user = await prisma.user.create({ data: { email: `h-src-${Date.now()}-${Math.random()}@test.local` } });
  const t = generateToken();
  await prisma.apiToken.create({ data: { userId: user.id, name: "t", tokenHash: t.hash, prefix: t.prefix } });
  return { user, raw: t.raw };
}

function jsonReq(url: string, raw: string | null, method = "GET", body?: unknown): Request {
  return new Request(url, {
    method,
    headers: {
      ...(raw ? { authorization: `Bearer ${raw}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe("/api/v1/sources handlers", () => {
  it("401s without a token", async () => {
    const res = await GET(jsonReq("https://x/api/v1/sources", null), { params: Promise.resolve({}) });
    expect(res.status).toBe(401);
  });

  it("creates, gets, lists, updates, deletes", async () => {
    const { raw } = await makeUserWithToken();
    const created = await POST(
      jsonReq("https://x/api/v1/sources", raw, "POST", { name: "Stripe", verifyStyle: "none" }),
      { params: Promise.resolve({}) },
    );
    expect(created.status).toBe(201);
    const src = await created.json();
    expect(src.hasSigningSecret).toBe(false);

    const got = await GET_ONE(jsonReq(`https://x/api/v1/sources/${src.id}`, raw), params(src.id));
    expect(got.status).toBe(200);

    const list = await GET(jsonReq("https://x/api/v1/sources?limit=5", raw), { params: Promise.resolve({}) });
    expect((await list.json()).data.some((s: { id: string }) => s.id === src.id)).toBe(true);

    const patched = await PATCH(jsonReq(`https://x/api/v1/sources/${src.id}`, raw, "PATCH", { name: "Renamed" }), params(src.id));
    expect((await patched.json()).name).toBe("Renamed");

    const del = await DELETE(jsonReq(`https://x/api/v1/sources/${src.id}`, raw, "DELETE"), params(src.id));
    expect(del.status).toBe(204);
  });

  it("404s on another user's source", async () => {
    const a = await makeUserWithToken();
    const b = await makeUserWithToken();
    const created = await POST(jsonReq("https://x/api/v1/sources", a.raw, "POST", { name: "A", verifyStyle: "none" }), { params: Promise.resolve({}) });
    const src = await created.json();
    const res = await GET_ONE(jsonReq(`https://x/api/v1/sources/${src.id}`, b.raw), params(src.id));
    expect(res.status).toBe(404);
  });

  it("400s on invalid body", async () => {
    const { raw } = await makeUserWithToken();
    const res = await POST(jsonReq("https://x/api/v1/sources", raw, "POST", { name: "" }), { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
  });
});
```

- [x] **Step 4: Run, verify it passes**

Run: `npm test -- src/app/api/v1/sources/route.test.ts`
Expected: PASS (4 tests).

- [x] **Step 5: Commit**

```bash
git add src/app/api/v1/sources
git commit -m "feat(api): /api/v1/sources CRUD handlers + tests"
```

---

## Task 11: Destinations route handlers + handler test

**Files:**
- Create: `src/app/api/v1/destinations/route.ts`
- Create: `src/app/api/v1/destinations/[id]/route.ts`
- Test: `src/app/api/v1/destinations/route.test.ts`

- [x] **Step 1: Collection handler**

```ts
// src/app/api/v1/destinations/route.ts
import { NextResponse } from "next/server";

import { withApiAuth, readJson } from "@/lib/api/handler";
import { parsePage } from "@/lib/api/respond";
import { createDestination, listDestinations } from "@/lib/services/destinations";

export const runtime = "nodejs";

export const GET = withApiAuth(async (req, auth) => {
  const result = await listDestinations(auth.userId, parsePage(new URL(req.url)));
  return NextResponse.json(result);
});

export const POST = withApiAuth(async (req, auth) => {
  const dto = await createDestination(auth.userId, (await readJson(req)) as never);
  return NextResponse.json(dto, { status: 201 });
});
```

- [x] **Step 2: Item handler**

```ts
// src/app/api/v1/destinations/[id]/route.ts
import { NextResponse } from "next/server";

import { withApiAuth, readJson, apiError } from "@/lib/api/handler";
import { getDestination, updateDestination, deleteDestination } from "@/lib/services/destinations";

export const runtime = "nodejs";

export const GET = withApiAuth(async (_req, auth, ctx) => {
  const { id } = await ctx.params;
  const dto = await getDestination(auth.userId, id);
  return dto ? NextResponse.json(dto) : apiError("not_found", "destination not found");
});

export const PATCH = withApiAuth(async (req, auth, ctx) => {
  const { id } = await ctx.params;
  const dto = await updateDestination(auth.userId, id, (await readJson(req)) as never);
  return dto ? NextResponse.json(dto) : apiError("not_found", "destination not found");
});

export const DELETE = withApiAuth(async (_req, auth, ctx) => {
  const { id } = await ctx.params;
  const ok = await deleteDestination(auth.userId, id);
  return ok ? new NextResponse(null, { status: 204 }) : apiError("not_found", "destination not found");
});
```

- [x] **Step 3: Handler test**

```ts
// src/app/api/v1/destinations/route.test.ts
import "dotenv/config";
import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/prisma";
import { generateToken } from "@/lib/api/token";
import { GET, POST } from "./route";
import { GET as GET_ONE, PATCH, DELETE } from "./[id]/route";

async function makeUserWithToken() {
  const user = await prisma.user.create({ data: { email: `h-dst-${Date.now()}-${Math.random()}@test.local` } });
  const t = generateToken();
  await prisma.apiToken.create({ data: { userId: user.id, name: "t", tokenHash: t.hash, prefix: t.prefix } });
  return { user, raw: t.raw };
}
function jsonReq(url: string, raw: string | null, method = "GET", body?: unknown): Request {
  return new Request(url, {
    method,
    headers: { ...(raw ? { authorization: `Bearer ${raw}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const noParams = { params: Promise.resolve({}) };

describe("/api/v1/destinations handlers", () => {
  it("401s without a token", async () => {
    expect((await GET(jsonReq("https://x/api/v1/destinations", null), noParams)).status).toBe(401);
  });

  it("creates a destination and hides secrets", async () => {
    const { raw } = await makeUserWithToken();
    const res = await POST(
      jsonReq("https://x/api/v1/destinations", raw, "POST", {
        name: "hook", url: "https://example.test/hook", outboundSecret: "supersecretsupersecret",
      }),
      noParams,
    );
    expect(res.status).toBe(201);
    const dto = await res.json();
    expect(dto.hasOutboundSecret).toBe(true);
    expect(dto.outboundSecretEnc).toBeUndefined();
  });

  it("400s on an SSRF-unsafe url", async () => {
    const { raw } = await makeUserWithToken();
    const res = await POST(
      jsonReq("https://x/api/v1/destinations", raw, "POST", { name: "x", url: "http://169.254.169.254/" }),
      noParams,
    );
    // Service throws a plain Error (not ZodError); withApiAuth rethrows → 500
    // unless the message matches /not found/. SSRF rejection is a client error,
    // so assert it is NOT a 2xx and surface as 400 — see Step 5 note.
    expect(res.status).toBe(400);
  });

  it("updates timeout, owner-scoped 404", async () => {
    const a = await makeUserWithToken();
    const b = await makeUserWithToken();
    const created = await POST(jsonReq("https://x/api/v1/destinations", a.raw, "POST", { name: "A", url: "https://example.test/" }), noParams);
    const dto = await created.json();
    const patched = await PATCH(jsonReq(`https://x/api/v1/destinations/${dto.id}`, a.raw, "PATCH", { timeoutMs: 5000 }), params(dto.id));
    expect((await patched.json()).timeoutMs).toBe(5000);
    expect((await GET_ONE(jsonReq(`https://x/api/v1/destinations/${dto.id}`, b.raw), params(dto.id))).status).toBe(404);
    expect((await DELETE(jsonReq(`https://x/api/v1/destinations/${dto.id}`, a.raw, "DELETE"), params(dto.id))).status).toBe(204);
  });
});
```

- [x] **Step 4: Run — the SSRF case will FAIL (500, not 400)**

Run: `npm test -- src/app/api/v1/destinations/route.test.ts`
Expected: the SSRF test fails (gets 500). This is intentional — the next step fixes the error mapping.

- [x] **Step 5: Map SSRF/validation Errors to 400 in `withApiAuth`**

The destination service throws a plain `Error` with message `Destination URL rejected: …` for SSRF and `Invalid header …` for header parsing. These are client errors, not 500s. Update the `catch` block in `src/lib/api/handler.ts` to recognize them — add this branch **before** the final `throw err`:

```ts
      if (
        err instanceof Error &&
        (/^Destination URL rejected:/.test(err.message) || /^Invalid header/.test(err.message))
      ) {
        return apiError("validation_error", err.message);
      }
```

- [x] **Step 6: Re-run, verify it passes**

Run: `npm test -- src/app/api/v1/destinations/route.test.ts`
Expected: PASS (4 tests).

- [x] **Step 7: Commit**

```bash
git add src/app/api/v1/destinations src/lib/api/handler.ts
git commit -m "feat(api): /api/v1/destinations CRUD handlers + 400-mapping for SSRF/header errors"
```

---

## Task 12: Routes route handlers + handler test

**Files:**
- Create: `src/app/api/v1/routes/route.ts`
- Create: `src/app/api/v1/routes/[id]/route.ts`
- Test: `src/app/api/v1/routes/route.test.ts`

- [x] **Step 1: Collection handler**

```ts
// src/app/api/v1/routes/route.ts
import { NextResponse } from "next/server";

import { withApiAuth, readJson } from "@/lib/api/handler";
import { parsePage } from "@/lib/api/respond";
import { createRoute, listRoutes } from "@/lib/services/routes";

export const runtime = "nodejs";

export const GET = withApiAuth(async (req, auth) => {
  const result = await listRoutes(auth.userId, parsePage(new URL(req.url)));
  return NextResponse.json(result);
});

export const POST = withApiAuth(async (req, auth) => {
  const dto = await createRoute(auth.userId, (await readJson(req)) as never);
  return NextResponse.json(dto, { status: 201 });
});
```

- [x] **Step 2: Item handler**

```ts
// src/app/api/v1/routes/[id]/route.ts
import { NextResponse } from "next/server";

import { withApiAuth, readJson, apiError } from "@/lib/api/handler";
import { getRoute, updateRoute, deleteRoute } from "@/lib/services/routes";

export const runtime = "nodejs";

export const GET = withApiAuth(async (_req, auth, ctx) => {
  const { id } = await ctx.params;
  const dto = await getRoute(auth.userId, id);
  return dto ? NextResponse.json(dto) : apiError("not_found", "route not found");
});

export const PATCH = withApiAuth(async (req, auth, ctx) => {
  const { id } = await ctx.params;
  const dto = await updateRoute(auth.userId, id, (await readJson(req)) as never);
  return dto ? NextResponse.json(dto) : apiError("not_found", "route not found");
});

export const DELETE = withApiAuth(async (_req, auth, ctx) => {
  const { id } = await ctx.params;
  const ok = await deleteRoute(auth.userId, id);
  return ok ? new NextResponse(null, { status: 204 }) : apiError("not_found", "route not found");
});
```

- [x] **Step 3: Handler test**

```ts
// src/app/api/v1/routes/route.test.ts
import "dotenv/config";
import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/prisma";
import { generateToken } from "@/lib/api/token";
import { POST } from "./route";
import { PATCH, DELETE } from "./[id]/route";

async function setup() {
  const user = await prisma.user.create({ data: { email: `h-rt-${Date.now()}-${Math.random()}@test.local` } });
  const t = generateToken();
  await prisma.apiToken.create({ data: { userId: user.id, name: "t", tokenHash: t.hash, prefix: t.prefix } });
  const source = await prisma.source.create({ data: { userId: user.id, name: "s", slug: `h-rt-${Date.now()}-${Math.random().toString(36).slice(2)}` } });
  const dest = await prisma.destination.create({ data: { userId: user.id, name: "d", url: "https://example.test/" } });
  return { raw: t.raw, source, dest };
}
function jsonReq(url: string, raw: string, method = "GET", body?: unknown): Request {
  return new Request(url, {
    method,
    headers: { authorization: `Bearer ${raw}`, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const noParams = { params: Promise.resolve({}) };

describe("/api/v1/routes handlers", () => {
  it("creates a route then 409s on duplicate", async () => {
    const { raw, source, dest } = await setup();
    const created = await POST(jsonReq("https://x/api/v1/routes", raw, "POST", { sourceId: source.id, destinationId: dest.id }), noParams);
    expect(created.status).toBe(201);
    const dup = await POST(jsonReq("https://x/api/v1/routes", raw, "POST", { sourceId: source.id, destinationId: dest.id }), noParams);
    expect(dup.status).toBe(409);
  });

  it("404s creating a route to a destination you don't own", async () => {
    const a = await setup();
    const b = await setup();
    const res = await POST(jsonReq("https://x/api/v1/routes", a.raw, "POST", { sourceId: a.source.id, destinationId: b.dest.id }), noParams);
    expect(res.status).toBe(404);
  });

  it("patches enabled and deletes", async () => {
    const { raw, source, dest } = await setup();
    const created = await POST(jsonReq("https://x/api/v1/routes", raw, "POST", { sourceId: source.id, destinationId: dest.id }), noParams);
    const route = await created.json();
    const patched = await PATCH(jsonReq(`https://x/api/v1/routes/${route.id}`, raw, "PATCH", { enabled: false }), params(route.id));
    expect((await patched.json()).enabled).toBe(false);
    expect((await DELETE(jsonReq(`https://x/api/v1/routes/${route.id}`, raw, "DELETE"), params(route.id))).status).toBe(204);
  });
});
```

- [x] **Step 4: Run, verify it passes**

Run: `npm test -- src/app/api/v1/routes/route.test.ts`
Expected: PASS (3 tests).

- [x] **Step 5: Commit**

```bash
git add src/app/api/v1/routes
git commit -m "feat(api): /api/v1/routes CRUD handlers + tests"
```

---

## Task 13: Events route handlers + handler test

**Files:**
- Create: `src/app/api/v1/events/route.ts`
- Create: `src/app/api/v1/events/[id]/route.ts`
- Test: `src/app/api/v1/events/route.test.ts`

- [x] **Step 1: Collection handler (list, paginated)**

```ts
// src/app/api/v1/events/route.ts
import { NextResponse } from "next/server";

import { withApiAuth } from "@/lib/api/handler";
import { parsePage } from "@/lib/api/respond";
import { listEvents } from "@/lib/services/events";

export const runtime = "nodejs";

export const GET = withApiAuth(async (req, auth) => {
  const result = await listEvents(auth.userId, parsePage(new URL(req.url)));
  return NextResponse.json(result);
});
```

- [x] **Step 2: Item handler (get with deliveries)**

```ts
// src/app/api/v1/events/[id]/route.ts
import { NextResponse } from "next/server";

import { withApiAuth, apiError } from "@/lib/api/handler";
import { getEvent } from "@/lib/services/events";

export const runtime = "nodejs";

export const GET = withApiAuth(async (_req, auth, ctx) => {
  const { id } = await ctx.params;
  const dto = await getEvent(auth.userId, id);
  return dto ? NextResponse.json(dto) : apiError("not_found", "event not found");
});
```

- [x] **Step 3: Handler test**

```ts
// src/app/api/v1/events/route.test.ts
import "dotenv/config";
import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/prisma";
import { generateToken } from "@/lib/api/token";
import { GET } from "./route";
import { GET as GET_ONE } from "./[id]/route";

async function setup() {
  const user = await prisma.user.create({ data: { email: `h-ev-${Date.now()}-${Math.random()}@test.local` } });
  const t = generateToken();
  await prisma.apiToken.create({ data: { userId: user.id, name: "t", tokenHash: t.hash, prefix: t.prefix } });
  const source = await prisma.source.create({ data: { userId: user.id, name: "s", slug: `h-ev-${Date.now()}-${Math.random().toString(36).slice(2)}` } });
  const event = await prisma.event.create({ data: { sourceId: source.id, method: "POST", headersJson: {}, bodyRaw: "{}" } });
  return { raw: t.raw, event };
}
function req(url: string, raw: string | null): Request {
  return new Request(url, { headers: raw ? { authorization: `Bearer ${raw}` } : {} });
}
const noParams = { params: Promise.resolve({}) };

describe("/api/v1/events handlers", () => {
  it("401s without a token", async () => {
    expect((await GET(req("https://x/api/v1/events", null), noParams)).status).toBe(401);
  });

  it("lists and gets an event with deliveries", async () => {
    const { raw, event } = await setup();
    const list = await GET(req("https://x/api/v1/events?limit=10", raw), noParams);
    expect(list.status).toBe(200);
    const got = await GET_ONE(req(`https://x/api/v1/events/${event.id}`, raw), { params: Promise.resolve({ id: event.id }) });
    const body = await got.json();
    expect(body.id).toBe(event.id);
    expect(Array.isArray(body.deliveries)).toBe(true);
  });

  it("404s on another user's event", async () => {
    const a = await setup();
    const b = await setup();
    const res = await GET_ONE(req(`https://x/api/v1/events/${a.event.id}`, b.raw), { params: Promise.resolve({ id: a.event.id }) });
    expect(res.status).toBe(404);
  });
});
```

- [x] **Step 4: Run, verify it passes**

Run: `npm test -- src/app/api/v1/events/route.test.ts`
Expected: PASS (3 tests).

- [x] **Step 5: Commit**

```bash
git add src/app/api/v1/events
git commit -m "feat(api): /api/v1/events read handlers + tests"
```

---

## Task 14: Token management Server Actions

**Files:**
- Create: `src/lib/actions/api-tokens.ts`
- Test: `src/lib/actions/api-tokens.test.ts`

The "create" action returns the raw token once so the page can display it. Because Server Actions return values to the client component, we return `{ token }` from create.

- [x] **Step 1: Write the failing test (DB-backed, calls non-action exports)**

The action functions call `auth()` internally, which is hard to unit-test. Extract the core into testable exports `createTokenForUser(userId, name)`, `listTokensForUser(userId)`, `revokeTokenForUser(userId, id)` in the same file, and have the `"use server"` actions wrap them with `requireUserId()`.

```ts
// src/lib/actions/api-tokens.test.ts
import "dotenv/config";
import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/prisma";
import { hashToken } from "@/lib/api/token";
import { createTokenForUser, listTokensForUser, revokeTokenForUser } from "./api-tokens";

async function makeUser() {
  return prisma.user.create({ data: { email: `tok-${Date.now()}-${Math.random()}@test.local` } });
}

describe("api-token management", () => {
  it("creates a token, returns raw once, stores only the hash", async () => {
    const u = await makeUser();
    const { token, record } = await createTokenForUser(u.id, "laptop");
    expect(token.startsWith("ody_")).toBe(true);
    const row = await prisma.apiToken.findUnique({ where: { id: record.id } });
    expect(row?.tokenHash).toBe(hashToken(token));
    expect(row?.prefix).toBe(token.slice(0, 8));
  });

  it("lists without exposing the hash", async () => {
    const u = await makeUser();
    await createTokenForUser(u.id, "a");
    const list = await listTokensForUser(u.id);
    expect(list.length).toBe(1);
    expect((list[0] as Record<string, unknown>).tokenHash).toBeUndefined();
    expect(list[0].name).toBe("a");
  });

  it("revoke is owner-scoped and sets revokedAt", async () => {
    const a = await makeUser();
    const b = await makeUser();
    const { record } = await createTokenForUser(a.id, "a");
    expect(await revokeTokenForUser(b.id, record.id)).toBe(false);
    expect(await revokeTokenForUser(a.id, record.id)).toBe(true);
    const row = await prisma.apiToken.findUnique({ where: { id: record.id } });
    expect(row?.revokedAt).not.toBeNull();
  });
});
```

- [x] **Step 2: Run, verify it fails**

Run: `npm test -- src/lib/actions/api-tokens.test.ts`
Expected: FAIL — cannot find module `./api-tokens`.

- [x] **Step 3: Implement**

```ts
// src/lib/actions/api-tokens.ts
"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { generateToken } from "@/lib/api/token";

async function requireUserId(): Promise<string> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("unauthorized");
  return session.user.id;
}

const nameSchema = z.string().min(1).max(60);

export type ApiTokenSummary = {
  id: string;
  name: string;
  prefix: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

export async function createTokenForUser(userId: string, name: string) {
  const parsedName = nameSchema.parse(name);
  const t = generateToken();
  const record = await prisma.apiToken.create({
    data: { userId, name: parsedName, tokenHash: t.hash, prefix: t.prefix },
  });
  return { token: t.raw, record };
}

export async function listTokensForUser(userId: string): Promise<ApiTokenSummary[]> {
  const rows = await prisma.apiToken.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
    revokedAt: r.revokedAt ? r.revokedAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function revokeTokenForUser(userId: string, id: string): Promise<boolean> {
  const res = await prisma.apiToken.updateMany({
    where: { id, userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return res.count > 0;
}

// ---- Server Actions used by the settings page form ----

/** Returns the raw token string ONCE for display. */
export async function createApiToken(formData: FormData): Promise<{ token: string }> {
  const userId = await requireUserId();
  const { token } = await createTokenForUser(userId, String(formData.get("name") ?? ""));
  revalidatePath("/settings/api-tokens");
  return { token };
}

export async function revokeApiToken(formData: FormData): Promise<void> {
  const userId = await requireUserId();
  await revokeTokenForUser(userId, String(formData.get("id")));
  revalidatePath("/settings/api-tokens");
}
```

- [x] **Step 4: Run, verify it passes**

Run: `npm test -- src/lib/actions/api-tokens.test.ts`
Expected: PASS (3 tests).

- [x] **Step 5: Commit**

```bash
git add src/lib/actions/api-tokens.ts src/lib/actions/api-tokens.test.ts
git commit -m "feat(api): token management actions (create/list/revoke)"
```

---

## Task 15: Token management UI page

**Files:**
- Create: `src/app/(dashboard)/settings/api-tokens/page.tsx`
- Modify: the settings navigation (find it first — see Step 1)

- [x] **Step 1: Locate the settings nav and the existing api-keys page for styling reference**

Run: `ls src/app/\(dashboard\)/settings && grep -rn "settings/api-keys" src/app src/components 2>/dev/null`
Read `src/app/(dashboard)/settings/api-keys/page.tsx` to match its layout, form styling, and how it wires Server Actions. Mirror that structure.

- [x] **Step 2: Implement the page**

Build a server component that lists tokens via `listTokensForUser(userId)` and renders:
- a "Create token" form (`name` input) wired to the `createApiToken` action;
- a one-time reveal of the returned raw token in a copy box (use a small client component that calls the action and shows the result, with the warning "You won't be able to see this again");
- a table of existing tokens (name, prefix + `…`, last used, created, revoked badge) each with a `revokeApiToken` form button.

```tsx
// src/app/(dashboard)/settings/api-tokens/page.tsx
import { auth } from "@/auth";
import { listTokensForUser } from "@/lib/actions/api-tokens";
import { CreateTokenForm } from "./create-token-form";
import { RevokeButton } from "./revoke-button";

export default async function ApiTokensPage() {
  const session = await auth();
  if (!session?.user?.id) return null;
  const tokens = await listTokensForUser(session.user.id);

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-xl font-semibold">API Tokens</h1>
        <p className="text-sm text-muted-foreground">
          Authenticate to the Odyhook REST API (<code>/api/v1</code>) with a
          bearer token. Tokens have full access to your account.
        </p>
      </header>

      <CreateTokenForm />

      <section>
        <h2 className="mb-2 text-sm font-medium">Your tokens</h2>
        <ul className="divide-y rounded-md border">
          {tokens.length === 0 && (
            <li className="p-4 text-sm text-muted-foreground">No tokens yet.</li>
          )}
          {tokens.map((t) => (
            <li key={t.id} className="flex items-center justify-between p-4">
              <div className="text-sm">
                <div className="font-medium">
                  {t.name} <span className="text-muted-foreground">({t.prefix}…)</span>
                  {t.revokedAt && <span className="ml-2 text-red-600">revoked</span>}
                </div>
                <div className="text-muted-foreground">
                  Last used: {t.lastUsedAt ?? "never"} · Created: {t.createdAt}
                </div>
              </div>
              {!t.revokedAt && <RevokeButton id={t.id} />}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
```

```tsx
// src/app/(dashboard)/settings/api-tokens/create-token-form.tsx
"use client";

import { useState } from "react";
import { createApiToken } from "@/lib/actions/api-tokens";

export function CreateTokenForm() {
  const [token, setToken] = useState<string | null>(null);

  async function action(formData: FormData) {
    const res = await createApiToken(formData);
    setToken(res.token);
  }

  return (
    <section className="space-y-3">
      <form action={action} className="flex gap-2">
        <input
          name="name"
          required
          maxLength={60}
          placeholder="Token name (e.g. my-laptop)"
          className="flex-1 rounded-md border px-3 py-2 text-sm"
        />
        <button type="submit" className="rounded-md border px-4 py-2 text-sm font-medium">
          Create token
        </button>
      </form>

      {token && (
        <div className="rounded-md border border-amber-400 bg-amber-50 p-3 text-sm">
          <p className="mb-1 font-medium text-amber-800">
            Copy this token now — you won&apos;t be able to see it again.
          </p>
          <code className="block break-all rounded bg-white p-2 font-mono text-xs">{token}</code>
        </div>
      )}
    </section>
  );
}
```

```tsx
// src/app/(dashboard)/settings/api-tokens/revoke-button.tsx
"use client";

import { revokeApiToken } from "@/lib/actions/api-tokens";

export function RevokeButton({ id }: { id: string }) {
  return (
    <form action={revokeApiToken}>
      <input type="hidden" name="id" value={id} />
      <button type="submit" className="rounded-md border px-3 py-1 text-sm text-red-600">
        Revoke
      </button>
    </form>
  );
}
```

> Adjust class names to match the project's actual Tailwind tokens/components found in Step 1. If the api-keys page uses shared `<Button>`/`<Card>` components, use those instead of raw elements.

- [x] **Step 3: Add the nav link**

Add a link to `/settings/api-tokens` wherever `/settings/api-keys` is linked (found in Step 1), labeled "API Tokens".

- [x] **Step 4: Verify build + manual check**

Run: `npm run build`
Then manually: `docker compose up -d && npm run dev`, sign in via MailHog (`localhost:8025`), visit `/settings/api-tokens`, create a token (confirm one-time reveal), copy it, revoke it.

- [x] **Step 5: Commit**

```bash
git add "src/app/(dashboard)/settings/api-tokens"
git commit -m "feat(api): API tokens settings page (create one-time reveal + revoke)"
```

---

## Task 16: OpenAPI spec

**Files:**
- Create: `public/openapi.json`

- [x] **Step 1: Write the spec**

Create `public/openapi.json` describing the v1 surface. Include: `openapi: 3.1.0`, `info` (title "Odyhook API", version "1.0.0"), `servers` (`https://odyhook.dev`), a `bearerAuth` security scheme (`type: http`, `scheme: bearer`), applied globally, and paths for every endpoint built in Tasks 10–13 with their request/response schemas (`Source`, `Destination`, `Route`, `Event`, `EventDetail`, `Delivery`, `Error`, and the `{ data, nextCursor }` list envelope). Mark secret fields as write-only (`signingSecret`, `outboundSecret`, `headers`) and expose the `hasX` booleans as read-only.

Minimal valid skeleton to extend (fill in all paths/schemas to match the handlers):

```json
{
  "openapi": "3.1.0",
  "info": { "title": "Odyhook API", "version": "1.0.0", "description": "Programmatic management of webhook sources, destinations, and routes." },
  "servers": [{ "url": "https://odyhook.dev" }],
  "security": [{ "bearerAuth": [] }],
  "components": {
    "securitySchemes": {
      "bearerAuth": { "type": "http", "scheme": "bearer", "description": "An API token from Settings → API Tokens (ody_…)." }
    },
    "schemas": {
      "Error": {
        "type": "object",
        "properties": { "error": { "type": "object", "properties": { "code": { "type": "string" }, "message": { "type": "string" } }, "required": ["code", "message"] } }
      }
    }
  },
  "paths": {}
}
```

- [x] **Step 2: Validate it parses**

Run: `node -e "JSON.parse(require('fs').readFileSync('public/openapi.json','utf8')); console.log('ok')"`
Expected: `ok`. (It's served statically at `/openapi.json`.)

- [x] **Step 3: Commit**

```bash
git add public/openapi.json
git commit -m "docs(api): OpenAPI 3.1 spec for /api/v1"
```

---

## Task 17: Env documentation + full suite + finish

**Files:**
- Modify: `infra/README.md`

- [x] **Step 1: Document the new env vars**

In `infra/README.md`, in the "Environment variables" table, add rows for `API_RATE_LIMIT_PER_SEC` (default 10) and `API_RATE_LIMIT_BURST` (default 30), runtime, "numeric tuning". Also remove the "Public API" ❌ row from any gap list if present, and note the API is live at `/api/v1` in the architecture/overview section.

- [x] **Step 2: Run the entire test suite**

Run: `docker compose up -d && npm test`
Expected: all suites pass, including the pre-existing ones (confirms the service refactor didn't break the UI actions' behavior).

- [x] **Step 3: Run the production build**

Run: `npm run build`
Expected: succeeds with no type errors.

- [x] **Step 4: Manual end-to-end smoke with curl**

```bash
# with dev running and a token minted in the UI as $TOK:
curl -s -X POST http://localhost:3000/api/v1/sources \
  -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  -d '{"name":"My Source","verifyStyle":"none"}'
curl -s http://localhost:3000/api/v1/sources -H "Authorization: Bearer $TOK"
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/v1/sources  # expect 401
```
Expected: create returns 201 + JSON with no secret fields; list returns `{ data, nextCursor }`; unauthenticated returns 401.

- [x] **Step 5: Commit**

```bash
git add infra/README.md
git commit -m "docs(infra): document API rate-limit env vars; mark public API shipped"
```

---

## Self-review notes (spec coverage)

- ✅ §1 ApiToken model → Task 1. Hashed, not encrypted → Tasks 1–2.
- ✅ §2 Service layer (Approach A) → Tasks 4–7; actions refactored to wrappers → Tasks 4–5.
- ✅ §3 Auth (bearer, sha256 lookup, revoked check, last-used, 401) → Task 8; userId scoping enforced in every service `where`.
- ✅ §4 Route surface (8 files, methods, write-only secrets) → Tasks 10–13; DTOs expose `hasX` booleans, never secret columns.
- ✅ §4 Conventions: error shape → Task 3 + handler mapping (Tasks 9, 11); pagination → Task 3 + services; rate limiting (`rl:api:<tokenId>`, fail-open) → Task 8–9.
- ✅ §5 Token management UI → Tasks 14–15.
- ✅ §6 OpenAPI → Task 16.
- ✅ §7 Tests: auth (401 missing/malformed/unknown/revoked), ownership cross-user, CRUD happy paths, events read, pagination cursor, 409 conflict, 400 validation/SSRF → distributed across Tasks 2–14.
- ✅ Verification (curl + suite) → Task 17.

**Known deviations from a naive reading of the spec, made explicit:**
- Per-token rate-limit *unit* test (429) is covered by the limiter's own existing tests + the fail-open path; an integration 429 test is omitted because it requires exhausting a live Redis bucket and would be flaky. The wrapper logic is small and exercised via the 401/CRUD handler tests.
- `toggleRoute` UI action is intentionally left untouched (its create-or-flip grid semantics don't map to the service's create/update split).
