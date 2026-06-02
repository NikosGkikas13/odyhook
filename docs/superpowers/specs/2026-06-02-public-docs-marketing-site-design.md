# Odyhook — Public docs & marketing site (Tier 3.5)

**Date:** 2026-06-02
**Status:** Design approved, pending implementation plan
**Source idea:** Tier 3.5 of the competitor gap analysis (`/docs`, `/use-cases`, `/pricing`, `/changelog`)

## Goal

Build Odyhook's public content surface. Today the only public pages are `/` (landing)
and `/signin`; a self-hosted product whose users must integrate themselves has no
integration docs, no use-case walkthroughs, no pricing statement, and no changelog.
This closes the marketing/docs gap identified as the last remaining Tier 3.5 item.

Four surfaces, one cohesive public content layer:

- **`/docs`** — comprehensive integration + reference guide (13 pages incl. index).
- **`/changelog`** — reverse-chronological release notes.
- **`/pricing`** — honest "self-hosted = free" statement.
- **`/use-cases`** — three concrete scenario walkthroughs.

## Decisions (locked during brainstorming)

| Decision | Choice |
|---|---|
| Scope | All of Tier 3.5 (all four surfaces) in one spec |
| Docs/changelog tooling | `@next/mdx` (file-based `page.mdx` routes) |
| Pricing/use-cases | Hand-designed TSX (marketing pages, not reference content) |
| Docs breadth | Everything: core integration + shipped surfaces (CLI/REST/MCP) + AI features |
| Syntax highlighting | Build-time Shiki via a rehype plugin (zero client JS) |
| Auth | None — public by default (proxy matcher is an allowlist) |

## Non-goals (YAGNI / explicitly deferred)

- Full-text docs search, versioned docs, i18n.
- CMS / MDX content framework beyond `@next/mdx`.
- `/vs/hookdeck`, `/vs/svix` comparison pages (premature; ship after the product can back them up).
- A standalone `/api` reference page — link to the existing `/openapi.json` instead.
- A blog.

## Architecture & file layout

A new public content layer alongside the existing landing page. The landing page
(`src/app/page.tsx`) stays **outside** the new route group so it keeps its bespoke
full-bleed layout.

```
src/
  mdx-components.tsx              # NEW — global MDX component mapping (Next 16 convention)
  app/
    (marketing)/                  # NEW route group — shared public chrome (top nav + footer)
      layout.tsx                  # public header (Docs · Use cases · Pricing · Changelog · Sign in) + footer
      pricing/page.tsx            # hand-designed TSX
      use-cases/page.tsx          # hand-designed TSX (3 scenario cards → detail sections)
      changelog/page.mdx          # single MDX file
      docs/
        layout.tsx                # docs shell: sidebar nav + content column + (optional) on-page TOC
        page.mdx                  # docs index / landing
        quickstart/page.mdx
        signature-verification/page.mdx
        outbound-hmac/page.mdx
        retries-and-backoff/page.mdx
        rate-limits/page.mdx
        idempotency/page.mdx
        cli/page.mdx
        rest-api/page.mdx
        mcp/page.mdx
        ai-filters-and-transforms/page.mdx
        nl-event-search/page.mdx
        ai-event-diffs/page.mdx
  lib/docs/nav.ts                 # NEW — ordered sidebar nav (sections → pages), single source of truth
next.config.ts                    # MODIFIED — compose withMDX with existing withSentryConfig; add Shiki rehype plugin
```

Key points:

- **No `proxy.ts` change.** The matcher (`src/proxy.ts`) is an allowlist of dashboard +
  `/api/events` routes, so all new pages are public automatically. A verification step
  confirms they render without a session.
- The `(marketing)` route group wraps only the four new surfaces with a consistent
  header/footer; it does not touch the landing page.
- `next.config.ts` already wraps with `withSentryConfig()`. The MDX wrapper must compose
  cleanly with it — exact ordering verified during planning against the Next 16 MDX docs
  in `node_modules/next/dist/docs/` (per AGENTS.md: "this is NOT the Next.js you know").
- `lib/docs/nav.ts` is the single source of truth for sidebar order + page titles.
  Adding a doc page = add an MDX file + one nav entry.

## Content plan & grounding rules

**Hard rule: every technical claim is grounded in the actual implementation, not in the
gap-analysis plan's prose.** Each page is verified against code before writing.

Facts already confirmed:

- **Outbound HMAC** (`src/lib/outbound-sign.ts`): header `X-Odyhook-Signature: v1=<hex>`,
  plus `X-Odyhook-Timestamp`; signed over `${timestamp}.${rawBody}` with HMAC-SHA256.
- **Retries** (`src/lib/queue.ts`): `RETRY_DELAYS_MS` array, 6 attempts total (5 retries),
  capped backoff. The page renders the *actual* array values, not hard-coded prose.
- **Rate limits** (`src/lib/ratelimit.ts`, ingest route): the 429 path returns `Retry-After`
  and `X-RateLimit-Remaining`. Docs describe only headers that actually exist.

### Docs pages (index + 12)

| Page | Grounded against |
|---|---|
| index | overview + nav to the rest |
| quickstart | ingest route, create-source flow, dashboard |
| signature-verification | inbound verifiers (Stripe / GitHub / generic-sha256) |
| outbound-hmac | `outbound-sign.ts` — verify snippets in 3 languages |
| retries-and-backoff | `queue.ts` `RETRY_DELAYS_MS`, worker terminal logic |
| rate-limits | `ratelimit.ts`, ingest 429 path |
| idempotency | `idempotency.ts`, `Event.idempotencyKey` unique index |
| cli | `cli/` — `ody listen` / `ody trigger`, SSE endpoint |
| rest-api | `/api/v1/*`, API tokens, cursor pagination, link to `/openapi.json` |
| mcp | `/api/mcp`, `ody_` token auth, tool surface (`src/lib/mcp/`) |
| ai-filters-and-transforms | `compile_filter`, QuickJS sandbox, BYOK |
| nl-event-search | `/api/v1/events/search`, `search_events` tool |
| ai-event-diffs | `/events/compare`, `AiEventDiff` model |

### Changelog

Seed with entries reconstructed from real merged PRs (#4–#10): metrics dashboard, public
REST API, CLI, AI fixtures, AI event diffs, MCP server, NL event search. Reverse-chronological,
dated, one MDX file.

### Pricing

Single honest message: "Self-hosted = free forever. BYOK. Here's what a ~€6/mo Hetzner box
runs." Built from the real cost table in `infra/README.md`.

### Use-cases

Three scenarios, each with short setup + the real commands/steps:

1. Stripe webhooks → dev laptop via the CLI.
2. GitHub PR events → Slack with a filter.
3. Fan out one signup webhook to Postgres + email + analytics.

**Scale note:** ~16 deliverable pages of grounded content. The implementation plan phases
this (infra → marketing pages → docs in batches), not one giant pass.

## UX, styling & shared components

- **Design language:** reuse existing tokens in `src/app/globals.css` (the `landing-*` /
  `btn-primary-ody` / `dot--*` system). No new design system; Tailwind 4 already present.
  Dark mode inherited via the existing `ThemeToggle`.
- **Public header** (`(marketing)/layout.tsx`): logo → `/`; nav Docs · Use cases · Pricing ·
  Changelog; right-aligned Sign in / Open dashboard (mirrors landing CTA logic via `auth()`).
  Shared footer matches the landing footer.
- **Docs shell** (`docs/layout.tsx`): left sidebar from `lib/docs/nav.ts` grouped into
  sections (Getting started / Delivery & reliability / Interfaces / AI) with active-page
  highlighting; center prose column; mobile sidebar collapses to a top disclosure.
- **MDX components** (`mdx-components.tsx`): styled `h1–h3` (anchor links), `pre`/`code`, `a`,
  `table`, plus:
  - `<Callout type="note|warning">` for gotchas (BYOK key required, no-delete MCP, etc.).
  - `<CodeTabs>` for multi-language verification snippets (Stripe/GitHub; JS/Python/Go).
- **Syntax highlighting:** Shiki at build time via `rehype-pretty-code` (or `@shikijs/rehype`),
  theme-matched to the app, zero client JS. Exact choice pinned during planning against the
  Next 16 MDX docs.
- **New dependencies:** `@next/mdx`, `@mdx-js/react`, `@types/mdx`, and the Shiki rehype
  plugin. All build-time/SSG — nothing added to the runtime container surface.

## Testing & verification

- **`next build` is the primary gate** — SSG renders every `page.mdx`, so broken MDX, bad
  imports, or unresolved custom components fail the build. `tsc` runs too (project norm:
  always tsc, not just vitest).
- **One unit test** (`lib/docs/nav.ts`): every nav entry resolves to an existing
  `docs/<slug>/page.mdx`, and every docs page appears in nav exactly once — prevents
  orphaned/dangling sidebar links.
- **Internal link check:** assert internal `/docs/...` links resolve to real routes; fail
  loudly on a dangling path.
- **Manual verification** (`run`/`verify` flow): `npm run dev`, walk `/docs` + each page,
  `/use-cases`, `/pricing`, `/changelog`; confirm sidebar nav, dark mode, code highlighting,
  mobile sidebar collapse. Confirm all pages load **without** signing in (public-access
  regression check against the proxy matcher).

## Open implementation-time questions (resolve in the plan, not blocking)

- Exact `withMDX` + `withSentryConfig` composition order in `next.config.ts` for Next 16.2.3.
- Final Shiki rehype plugin choice (`rehype-pretty-code` vs `@shikijs/rehype`).
- Whether the docs shell needs an on-page TOC (right rail) or sidebar-only is enough for v1.
