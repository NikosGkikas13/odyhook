# API reference + competitor comparison pages — design

**Date:** 2026-06-03
**Status:** approved (pending spec review)
**Scope:** Two "worth doing eventually" items from the competitor gap analysis:
1. `/docs/api-reference` — a REST reference rendered from the existing OpenAPI spec.
2. `/vs/hookdeck` and `/vs/svix` — honest competitor comparison pages.

Both are public, **statically rendered** marketing/docs pages. Neither touches a
dynamic (request-time) API, so they prerender at build (`○`) and preserve the
SSG won in the previous branch.

---

## Part A — REST reference (`/docs/api-reference`)

### Source of truth
`public/openapi.json` — a real OpenAPI **3.1.0** spec served at `/openapi.json`.
Current shape: 8 paths (Sources / Destinations / Routes / Events CRUD), 13
component schemas, HTTP bearer auth (`ody_…` tokens). The page renders **strictly
from this spec**, so it cannot drift from the API contract.

Out of scope: the spec omits `POST /api/v1/events/search` and `POST /api/v1/fixtures`
— those remain documented in the prose `/docs/rest-api` page. (A future change
could add them to the spec; not part of this work.)

### Renderer (`src/lib/openapi/`)
Pure, build-time, node-testable logic — no React, no request-time inputs.

- `spec.ts` — imports `public/openapi.json` (typed via a small local `OpenApiSpec`
  type) and re-exports it. A static `import` of JSON keeps the page static.
- `model.ts` — transforms the raw spec into render-ready structures:
  - `getOperations(spec)` → operations grouped by **resource** (derived from the
    path, e.g. `/api/v1/sources` → "Sources"), each with `{ method, path, summary,
    description, parameters, requestSchemaRef, responses }`.
  - `resolveRef(spec, "#/components/schemas/Source")` → the schema object.
  - `getSchemas(spec)` → the 13 component schemas as `{ name, fields[] }`, where
    each field is `{ name, type, required, description }` (arrays/refs flattened to
    a readable type string like `Source[]` or `string (uuid)`).
- These functions are the unit-test surface (grouping correctness, `$ref`
  resolution, required-field derivation, type-string formatting).

### Page (`src/app/(marketing)/docs/api-reference/page.tsx`)
Server component, static. Sits inside the existing `/docs` layout (inherits the
docs sidebar + prose styles). Structure:

1. Intro: title, the `info.description`, base server URL, and an auth Callout
   (bearer `ody_` token, link to Settings → API Tokens).
2. **Operations**, grouped by resource. Each operation card:
   - `METHOD /path` heading, summary/description.
   - Path/query **parameters** table (name, in, type, required, description).
   - Request body: rendered as a **schema field table** (not raw JSON).
   - Responses: status + description + body schema reference.
   - A `curl` example built from method/path/auth (styled `<pre>`, no extra
     syntax-highlighter dependency).
3. **Schemas** section: each of the 13 schemas as a field table
   (field / type / required / description). Operation request/response refs link
   to the matching schema by anchor (`#schema-source`).

Rationale for **tables over raw JSON**: a field table is the standard reference
UX (reads better than dumping JSON), and it keeps the renderer dependency-light
(no Shiki/JSON highlighter needed in a TSX page).

### Wiring
- `src/lib/docs/nav.ts`: add `{ slug: "api-reference", title: "API reference" }`
  to the **Interfaces** section (after `rest-api`).
- `nav.test.ts`: the "every nav slug has a backing page.mdx" test hardcodes
  `existsSync(<slug>/page.mdx)` (lines 15–23). Change it to accept **either**
  `page.mdx` or `page.tsx` (`hasPage = existsSync(.../page.mdx) || existsSync(.../page.tsx)`)
  and rename it to "…has a backing page", so the TSX `api-reference` page passes.
- `/docs/rest-api/page.mdx`: add a line linking to `/docs/api-reference`
  ("Full endpoint reference, rendered from the OpenAPI spec → …").

### Testing
- `src/lib/openapi/model.test.ts` (node): grouping by resource, `$ref`
  resolution, required-field + type-string derivation, schema/operation counts
  match the spec.
- `nav.test.ts`: stays green with the new `api-reference` entry (after the
  page.tsx accommodation).
- `next build`: `/docs/api-reference` renders as `○` (Static).

---

## Part B — Competitor comparison pages (`/vs/hookdeck`, `/vs/svix`)

### Approach
Data-driven. One typed dataset per competitor + one shared renderer + two thin
static route pages.

### Data (`src/lib/marketing/comparisons.ts`)
A typed `Comparison` object per competitor:

```ts
type Cell = { value: "yes" | "no" | "partial"; note?: string };
type FeatureRow = { capability: string; odyhook: Cell; competitor: Cell };
type Comparison = {
  slug: "hookdeck" | "svix";
  competitor: string;          // "Hookdeck", "Svix"
  asOf: string;                // "June 2026"
  positioning: string;         // honest one-paragraph framing
  features: FeatureRow[];
  competitorStrengths: string[]; // where they genuinely win
  pickOdyhookIf: string[];
  pickCompetitorIf: string[];
  sources: { label: string; url: string }[];
};
```

**Honest framing baked into the data** (per the plan's "don't be smug" caveat):
- Odyhook is a self-hosted **receiver/router** (ingest from providers → forward
  to your destinations). Hookdeck's *Event Gateway* (SaaS) is the closest
  overlap; *Outpost* (Apache-2.0, self-hostable) is a separate **sending**
  product. Svix is primarily **sender-side** (help a SaaS send webhooks to *its*
  users) with an embeddable customer portal.
- Each competitor's genuine strengths are stated explicitly.

### Verified facts (as of June 2026 — to render with source links)

**Hookdeck Event Gateway** — SaaS. Source: https://hookdeck.com/pricing
- Developer (Free): $0/mo, 10k events, 3-day retention, 1 user, SOC 2.
- Team: from $39/mo, 7-day retention, unlimited users, pay-as-you-go.
- Growth: from $499/mo, 30-day retention, uptime/latency SLAs, SSO/SAML/SCIM.
- Enterprise: custom. Overage ≈ $1 per additional 100k events.
- 120+ preconfigured sources, filtering, dedup, visual tracing, full-text search,
  issue tracking, Slack/PagerDuty/OpsGenie alerting. Outpost (sending) is
  Apache-2.0 self-hostable. Source: https://github.com/hookdeck/outpost

**Svix** — open-source (MIT) + SaaS. Sources: https://www.svix.com/pricing/ ,
https://github.com/svix/svix-webhooks
- Free: $0/mo, 50k msgs/mo, 30-day retention, 99.9% SLA, 200 msg/s, embeddable
  UI, transformations.
- Professional: from $490/mo, 90-day retention, 99.99% SLA, 800 msg/s, unbranded
  portal, static IPs, SOC 2 Type II.
- Enterprise: custom, 99.999% SLA, on-prem, SSO, audit logs, private networking.
- Usage = attempted messages only (filtered + retries free). MIT Rust server is
  self-hostable (Postgres + optional Redis); the built-in portal UI is SaaS-only.

**Odyhook** (for contrast — from `infra/README.md`): self-hosted only, ~€6/mo
flat (your own CX23 + BYOK), no per-event pricing, BYOK-AI (filters/transforms/
diagnosis/NL search/MCP/event diffs), CLI (`ody`), MCP server. No SOC 2/SSO/SLA,
no embeddable customer portal, no non-HTTP destinations — stated honestly.

### Comparison axes (feature matrix rows)
Deployment model (self-host vs SaaS), pricing model (flat vs per-event/seat),
open-source, signature verification (inbound), outbound HMAC signing, retries/
backoff, idempotency, filtering, transformations, replay, CLI/local-dev tunnel,
MCP / AI-agent surface, **BYOK AI features**, embeddable customer portal,
non-HTTP destinations (Kafka/SQS/…), preconfigured source catalog, enterprise
compliance (SOC 2/SSO/SLA). Each cell `yes/no/partial` + a short factual note.

### Shared renderer (`src/components/marketing/comparison-page.tsx`)
Client-free server component. Renders: hero (positioning + `asOf` stamp),
the feature matrix table (Odyhook column vs competitor column, with cell notes),
"Where {competitor} is stronger", a two-column "Pick Odyhook if / Pick
{competitor} if", and a sources footer with dated links. Matches the existing
`/pricing` + `/use-cases` TSX aesthetic (hand-built cards, design tokens).

### Route pages
- `src/app/(marketing)/vs/hookdeck/page.tsx` and `.../vs/svix/page.tsx` — each
  imports its `Comparison` and renders `<ComparisonPage>`. Static. Each sets
  `metadata` (title/description) for SEO.

### Discovery
Link both from `/pricing` (a small "Compare: vs Hookdeck · vs Svix" line) rather
than adding to the header nav (keeps the primary nav at Docs/Use cases/Pricing/
Changelog). No header-nav change.

### Tone guardrails
Factual, datestamped ("as of June 2026"), every competitor claim traceable to a
linked source, non-disparaging, competitor strengths stated plainly. Lead with
Odyhook's real wedge (self-hosted, flat cost, BYOK-AI), not with put-downs.

### Testing
- `src/lib/marketing/comparisons.test.ts` (node): structural integrity — every
  `FeatureRow` has both `odyhook` and `competitor` cells; required fields present;
  `asOf` set; at least one source link per competitor; slugs unique.
- `next build`: `/vs/hookdeck` and `/vs/svix` render as `○` (Static).

---

## Cross-cutting

- **Static rendering is a hard requirement** for all three pages — server
  components, no `auth()` / cookies / headers / request-time data.
- **No new heavy dependencies** — no API-explorer library, no syntax highlighter
  added; reuse existing design tokens and Tailwind.
- **Verification**: `tsc --noEmit` clean; full vitest suite green incl. the two
  new node tests; `next build` shows all three new routes as `○`.

## Files

New:
- `src/lib/openapi/spec.ts`, `src/lib/openapi/model.ts`, `src/lib/openapi/model.test.ts`
- `src/app/(marketing)/docs/api-reference/page.tsx`
- `src/lib/marketing/comparisons.ts`, `src/lib/marketing/comparisons.test.ts`
- `src/components/marketing/comparison-page.tsx`
- `src/app/(marketing)/vs/hookdeck/page.tsx`, `src/app/(marketing)/vs/svix/page.tsx`

Modified:
- `src/lib/docs/nav.ts` (add `api-reference` entry)
- `src/lib/docs/nav.test.ts` (accept a `.tsx` docs page)
- `src/app/(marketing)/docs/rest-api/page.mdx` (link to the reference)
- `src/app/(marketing)/pricing/page.tsx` (link to the `/vs/*` pages)
