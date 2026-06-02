# Public Docs & Marketing Site Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Odyhook's public content surface — `/docs` (13 pages), `/changelog`, `/pricing`, `/use-cases` — built on `@next/mdx` for docs/changelog and hand-designed TSX for the marketing pages.

**Architecture:** A new un-gated `(marketing)` route group provides shared public chrome (header + footer). Docs and changelog are file-based `page.mdx` routes styled through a global `src/mdx-components.tsx` map; the docs shell adds a sidebar driven by a single nav source of truth (`src/lib/docs/nav.ts`). Pricing and use-cases are hand-written TSX. The existing landing page (`src/app/page.tsx`) stays untouched outside the group.

**Tech Stack:** Next.js 16.2.3 (App Router, **Turbopack**), `@next/mdx`, Shiki via `rehype-pretty-code`, `remark-gfm`, `rehype-slug`, Tailwind 4 + existing bespoke CSS tokens, Vitest 4.

---

## Pre-flight notes (read before starting)

These are project-specific facts verified against the codebase. Getting them wrong wastes a build cycle.

1. **Turbopack requires STRING plugin names.** This project runs Turbopack (`next.config.ts` sets `turbopack.root`; `next dev` uses it). Per `node_modules/next/dist/docs/01-app/02-guides/mdx.md`, remark/rehype plugins must be passed as **string names with serializable options only** — imported plugin functions will not work under Turbopack. All plugin options in this plan are plain strings/booleans/objects (serializable).
2. **No `@tailwindcss/typography`.** It is NOT installed and we are NOT adding it. MDX prose is styled via the component map in `src/mdx-components.tsx` plus a `.docs-prose` block in `globals.css`, matching the project's bespoke-CSS convention (`landing-*`, `dot--*` classes).
3. **Public by default.** `src/proxy.ts` uses an **allowlist** matcher (only `/sources`, `/events`, `/destinations`, `/routes`, `/settings`, `/api/events`). New routes are public automatically — do NOT modify `proxy.ts`.
4. **`mdx-components.tsx` signature (Next 16):** export a single `useMDXComponents(): MDXComponents` that takes **no arguments** (verified in `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/mdx-components.md`). Place it at `src/mdx-components.tsx`.
5. **Config composition:** `withSentryConfig(withMDX(nextConfig), { silent: true })` — MDX wraps the base config, Sentry stays outermost. Keep the existing `turbopack.root`.
6. **Grounding rule:** every technical claim in a docs page is verified against the named source file at write time. Do not copy prose from the gap-analysis plan — it may be stale.

### Verified facts to embed (single source of truth for the content tasks)

- **Retry schedule** (`src/lib/queue.ts` `RETRY_DELAYS_MS`): `10s, 30s, 2m, 10m, 1h, 6h` — 6 attempts total (5 retries).
- **Outbound HMAC** (`src/lib/outbound-sign.ts`): header `X-Odyhook-Signature: v1=<hex>` + `X-Odyhook-Timestamp`; signed value is `` `${timestamp}.${rawBody}` `` with HMAC-SHA256.
- **Inbound verifiers** (`src/lib/hmac.ts`, `VerifyStyle`): `stripe` (header `Stripe-Signature: t=…,v1=…`, 300s tolerance), `github` (header `x-hub-signature-256`, `sha256=` prefix), `generic-sha256` (header `x-signature-256` or `x-signature`).
- **Rate limit** (`src/app/api/ingest/[slug]/route.ts`): 429 returns `Retry-After` + `X-RateLimit-Remaining`. Describe only these.
- **CLI** (`cli/README.md`, `cli/src/index.ts`): `ody listen --source <slug> --forward <url> [--since 1h]`; `ody trigger <slug> --data @file|-  [--header "K: V"] [--replay evt_…] [--generate "desc"] [--dry-run]`. Auth via `ody_` token.
- **REST v1 routes** (`src/app/api/v1/*`): `sources`, `destinations`, `routes`, `events` (CRUD + `[id]`), `events/search`, `fixtures`, `listen`. API-token (`ody_`) auth, cursor pagination, spec at `/openapi.json`.
- **MCP** (`src/lib/mcp/tools.ts`): `POST /api/mcp`, `ody_` token auth, read + safe-write tools (e.g. `list_sources`, `get_source`, `list_events`, `list_deliveries`, `create_route`, `set_route_filter`, `pause_destination`, `compile_filter`, `search_events`). **No delete tools.**

---

## File structure

```
src/
  mdx-components.tsx                       # NEW — global MDX component map (Callout, CodeTabs, styled html)
  app/
    globals.css                           # MODIFY — append .docs-* / .marketing-* style block
    page.tsx                              # UNTOUCHED (landing stays outside the group)
    (marketing)/                          # NEW route group
      layout.tsx                          # public header + footer chrome
      pricing/page.tsx                    # hand-designed TSX
      use-cases/page.tsx                  # hand-designed TSX
      changelog/page.mdx                  # single MDX file
      docs/
        layout.tsx                        # docs shell (sidebar + content column)
        page.mdx                          # docs index
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
  components/
    docs/
      callout.tsx                         # NEW — <Callout type="note|warning">
      code-tabs.tsx                       # NEW — <CodeTabs> client component
      docs-sidebar.tsx                    # NEW — client sidebar (active highlight, mobile disclosure)
    marketing/
      marketing-header.tsx                # NEW — client top-nav (active highlight)
  lib/
    docs/
      nav.ts                              # NEW — ordered sidebar nav (single source of truth)
      nav.test.ts                         # NEW — nav ↔ filesystem consistency test
next.config.ts                            # MODIFY — withMDX + pageExtensions + string plugins
package.json                              # MODIFY — new deps
```

---

## Phase 0 — MDX pipeline

### Task 1: Install MDX + markdown dependencies

**Files:**
- Modify: `package.json` (via npm)

- [ ] **Step 1: Install build-time deps**

Run:
```bash
npm install @next/mdx @mdx-js/loader @mdx-js/react @types/mdx remark-gfm rehype-slug rehype-pretty-code shiki
```
Expected: packages added to `dependencies`, no peer-dep errors. (`shiki` is the peer dep of `rehype-pretty-code`.)

- [ ] **Step 2: Verify the app still builds before any wiring**

Run: `npm run build`
Expected: PASS (deps installed but not yet referenced).

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "build: add @next/mdx + markdown toolchain deps"
```

### Task 2: Wire MDX into next.config.ts (Turbopack-safe)

**Files:**
- Modify: `next.config.ts`

- [ ] **Step 1: Rewrite `next.config.ts`**

Replace the file with:
```ts
import { withSentryConfig } from "@sentry/nextjs";
import createMDX from "@next/mdx";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Let .mdx files act as routes/pages.
  pageExtensions: ["ts", "tsx", "js", "jsx", "md", "mdx"],
  turbopack: {
    // Pin the workspace root to this project so Turbopack doesn't pick up
    // an outer lockfile at ~/package-lock.json.
    root: process.cwd(),
  },
};

// Plugins are passed as STRING names because this project runs Turbopack,
// which cannot serialize imported plugin functions to its Rust core. Options
// must stay serializable (strings/booleans/objects only). See
// node_modules/next/dist/docs/01-app/02-guides/mdx.md.
const withMDX = createMDX({
  options: {
    remarkPlugins: ["remark-gfm"],
    rehypePlugins: [
      "rehype-slug",
      [
        "rehype-pretty-code",
        {
          theme: "github-dark-dimmed",
          // Our .docs-prose CSS owns the code-block background.
          keepBackground: false,
        },
      ],
    ],
  },
});

// withSentryConfig also handles route-instrumentation; org/project are
// omitted intentionally — source-map upload would require an auth token
// we don't have yet. MDX wraps the base config; Sentry stays outermost.
export default withSentryConfig(withMDX(nextConfig), {
  silent: true,
});
```

- [ ] **Step 2: Verify config type-checks**

Run: `npx tsc --noEmit`
Expected: PASS. (If `createMDX`'s options type rejects the string-tuple form, add `// @ts-expect-error Turbopack string-plugin form` directly above the offending `options` key and re-run — do NOT switch to imported functions.)

- [ ] **Step 3: Commit**

```bash
git add next.config.ts
git commit -m "feat(docs): enable @next/mdx with Turbopack-safe string plugins"
```

### Task 3: Create the global MDX component map

**Files:**
- Create: `src/mdx-components.tsx`
- Depends on (created in later tasks, but referenced here): `src/components/docs/callout.tsx`, `src/components/docs/code-tabs.tsx`

> Build order: create the two components in Task 4 first if executing strictly; this task imports them. (Subagent-driven execution: do Task 4 before Task 3, or stub the imports.) To keep imports valid, **do Task 4 before Task 3.**

- [ ] **Step 1: Write `src/mdx-components.tsx`**

```tsx
import type { MDXComponents } from "mdx/types";
import Link from "next/link";

import { Callout } from "@/components/docs/callout";
import { CodeTabs } from "@/components/docs/code-tabs";

// Global MDX component map (Next 16 file convention — useMDXComponents takes
// no args). Styling rides on the .docs-prose block in globals.css; we only
// override <a> to use next/link for internal hrefs and expose the custom
// Callout / CodeTabs components so .mdx files can use them without importing.
const components: MDXComponents = {
  a: ({ href = "", children, ...rest }) => {
    const isInternal = href.startsWith("/") || href.startsWith("#");
    if (isInternal) {
      return (
        <Link href={href} {...rest}>
          {children}
        </Link>
      );
    }
    return (
      <a href={href} target="_blank" rel="noreferrer" {...rest}>
        {children}
      </a>
    );
  },
  Callout,
  CodeTabs,
};

export function useMDXComponents(): MDXComponents {
  return components;
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/mdx-components.tsx
git commit -m "feat(docs): global MDX component map"
```

### Task 4: Build the Callout and CodeTabs components

**Files:**
- Create: `src/components/docs/callout.tsx`
- Create: `src/components/docs/code-tabs.tsx`

- [ ] **Step 1: Write `src/components/docs/callout.tsx`**

```tsx
// Server component — a styled note/warning box for docs. Classes are defined
// in the .docs-callout block of globals.css.
export function Callout({
  type = "note",
  children,
}: {
  type?: "note" | "warning";
  children: React.ReactNode;
}) {
  return (
    <div className={`docs-callout docs-callout--${type}`} role="note">
      <div className="docs-callout-body">{children}</div>
    </div>
  );
}
```

- [ ] **Step 2: Write `src/components/docs/code-tabs.tsx`**

```tsx
"use client";

import { useState } from "react";

// Client component for multi-language code snippets. Usage in MDX:
//   <CodeTabs tabs={[{ label: "Node", code: "..." }, { label: "Python", code: "..." }]} />
// The code strings are pre-rendered text (no Shiki highlighting inside tabs —
// keeps it Turbopack-simple; fenced code blocks elsewhere get Shiki).
export function CodeTabs({
  tabs,
}: {
  tabs: { label: string; code: string }[];
}) {
  const [active, setActive] = useState(0);
  return (
    <div className="docs-codetabs">
      <div className="docs-codetabs-bar" role="tablist">
        {tabs.map((t, i) => (
          <button
            key={t.label}
            role="tab"
            aria-selected={i === active}
            className={i === active ? "is-active" : undefined}
            onClick={() => setActive(i)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <pre className="docs-codetabs-pre">
        <code>{tabs[active]?.code}</code>
      </pre>
    </div>
  );
}
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/docs/callout.tsx src/components/docs/code-tabs.tsx
git commit -m "feat(docs): Callout and CodeTabs MDX components"
```

> **Reminder:** execute Task 4 before Task 3 so Task 3's imports resolve.

---

## Phase 1 — Shared chrome, docs shell, nav

### Task 5: Add docs/marketing CSS to globals.css

**Files:**
- Modify: `src/app/globals.css` (append at end)

- [ ] **Step 1: Append the style block**

Append to the end of `src/app/globals.css`:
```css
/* ============================================================
   Public docs + marketing surfaces
   ============================================================ */

.marketing-shell { display: flex; flex-direction: column; min-height: 100%; }
.marketing-main { flex: 1; width: 100%; max-width: 72rem; margin: 0 auto; padding: 2rem 1.25rem 4rem; }

.marketing-header {
  display: flex; align-items: center; gap: 1.5rem;
  padding: 0.85rem 1.25rem; border-bottom: 1px solid var(--zinc-200);
}
.dark .marketing-header { border-color: var(--zinc-800); }
.marketing-header-nav { display: flex; gap: 1.25rem; font-size: 0.875rem; }
.marketing-header-spacer { flex: 1; }

/* Docs two-column shell */
.docs-shell { display: grid; grid-template-columns: 16rem minmax(0, 1fr); gap: 2.5rem;
  width: 100%; max-width: 72rem; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
@media (max-width: 768px) { .docs-shell { grid-template-columns: 1fr; gap: 1rem; } }

.docs-sidebar { font-size: 0.875rem; }
.docs-sidebar-section { margin-bottom: 1.25rem; }
.docs-sidebar-section h4 { text-transform: uppercase; letter-spacing: 0.04em;
  font-size: 0.7rem; color: var(--fg-3); margin-bottom: 0.4rem; }
.docs-sidebar a { display: block; padding: 0.2rem 0; color: var(--fg-2); }
.docs-sidebar a:hover { color: var(--fg-1); }
.docs-sidebar a.is-active { color: var(--brand-blue); font-weight: 600; }

/* Prose */
.docs-prose { max-width: 46rem; line-height: 1.7; color: var(--fg-1); }
.docs-prose h1 { font-size: 2rem; font-weight: 800; margin: 0 0 1rem; }
.docs-prose h2 { font-size: 1.4rem; font-weight: 700; margin: 2.25rem 0 0.75rem; }
.docs-prose h3 { font-size: 1.1rem; font-weight: 600; margin: 1.75rem 0 0.5rem; }
.docs-prose p, .docs-prose ul, .docs-prose ol { margin: 0.75rem 0; }
.docs-prose ul, .docs-prose ol { padding-left: 1.25rem; }
.docs-prose li { margin: 0.25rem 0; }
.docs-prose a { color: var(--brand-blue); text-decoration: underline; text-underline-offset: 2px; }
.docs-prose code { font-family: var(--font-geist-mono), monospace; font-size: 0.85em;
  background: var(--bg-muted); padding: 0.1em 0.35em; border-radius: 4px; }
.docs-prose pre { background: var(--zinc-950); color: var(--zinc-100); padding: 1rem 1.1rem;
  border-radius: 8px; overflow-x: auto; margin: 1rem 0; font-size: 0.85rem; }
.docs-prose pre code { background: none; padding: 0; font-size: inherit; color: inherit; }
.docs-prose table { width: 100%; border-collapse: collapse; margin: 1rem 0; font-size: 0.9rem; }
.docs-prose th, .docs-prose td { border: 1px solid var(--zinc-200); padding: 0.45rem 0.6rem; text-align: left; }
.dark .docs-prose th, .dark .docs-prose td { border-color: var(--zinc-800); }

/* Callout */
.docs-callout { border-left: 3px solid var(--brand-blue); background: var(--brand-blue-tint);
  padding: 0.75rem 1rem; border-radius: 6px; margin: 1.25rem 0; }
.docs-callout--warning { border-left-color: var(--status-failed); background: var(--status-failed-tint); }
.docs-callout-body > :first-child { margin-top: 0; }
.docs-callout-body > :last-child { margin-bottom: 0; }

/* CodeTabs */
.docs-codetabs { margin: 1rem 0; border-radius: 8px; overflow: hidden; background: var(--zinc-950); }
.docs-codetabs-bar { display: flex; gap: 0.25rem; padding: 0.4rem 0.5rem 0; background: var(--zinc-900); }
.docs-codetabs-bar button { color: var(--zinc-400); background: none; border: none;
  padding: 0.35rem 0.7rem; font-size: 0.8rem; cursor: pointer; border-radius: 6px 6px 0 0; }
.docs-codetabs-bar button.is-active { color: var(--zinc-50); background: var(--zinc-950); }
.docs-codetabs-pre { margin: 0; padding: 1rem 1.1rem; color: var(--zinc-100); overflow-x: auto; font-size: 0.85rem; }

/* Marketing page primitives */
.marketing-h1 { font-size: 2.5rem; font-weight: 800; line-height: 1.1; margin-bottom: 1rem; }
.marketing-lede { font-size: 1.1rem; color: var(--fg-2); max-width: 40rem; }
.marketing-card-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
  gap: 1.25rem; margin: 2rem 0; }
.marketing-card { border: 1px solid var(--zinc-200); border-radius: 10px; padding: 1.25rem; }
.dark .marketing-card { border-color: var(--zinc-800); }
```

- [ ] **Step 2: Commit**

```bash
git add src/app/globals.css
git commit -m "feat(docs): styles for docs prose, callouts, code tabs, marketing"
```

### Task 6: Create the docs nav source of truth

**Files:**
- Create: `src/lib/docs/nav.ts`

- [ ] **Step 1: Write `src/lib/docs/nav.ts`**

```ts
// Single source of truth for the docs sidebar. Each item's `slug` is the
// path segment under /docs (empty string = the /docs index). Adding a doc
// page = add a page.mdx folder AND an entry here. The nav.test.ts test
// enforces that these stay in sync.

export type DocLink = { slug: string; title: string };
export type DocSection = { title: string; links: DocLink[] };

export const DOCS_NAV: DocSection[] = [
  {
    title: "Getting started",
    links: [
      { slug: "", title: "Overview" },
      { slug: "quickstart", title: "Quickstart" },
    ],
  },
  {
    title: "Delivery & reliability",
    links: [
      { slug: "signature-verification", title: "Signature verification" },
      { slug: "outbound-hmac", title: "Outbound HMAC" },
      { slug: "retries-and-backoff", title: "Retries & backoff" },
      { slug: "rate-limits", title: "Rate limits" },
      { slug: "idempotency", title: "Idempotency" },
    ],
  },
  {
    title: "Interfaces",
    links: [
      { slug: "cli", title: "CLI (ody)" },
      { slug: "rest-api", title: "REST API" },
      { slug: "mcp", title: "MCP server" },
    ],
  },
  {
    title: "AI features",
    links: [
      { slug: "ai-filters-and-transforms", title: "AI filters & transforms" },
      { slug: "nl-event-search", title: "Natural-language event search" },
      { slug: "ai-event-diffs", title: "AI event diffs" },
    ],
  },
];

// Flat helper: every slug the docs section is expected to contain.
export const DOC_SLUGS: string[] = DOCS_NAV.flatMap((s) =>
  s.links.map((l) => l.slug),
);

export function hrefForSlug(slug: string): string {
  return slug === "" ? "/docs" : `/docs/${slug}`;
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/docs/nav.ts
git commit -m "feat(docs): docs nav source of truth"
```

### Task 7: Nav ↔ filesystem consistency test (TDD)

**Files:**
- Create: `src/lib/docs/nav.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DOC_SLUGS } from "./nav";

const DOCS_DIR = join(process.cwd(), "src", "app", "(marketing)", "docs");

describe("docs nav", () => {
  it("has no duplicate slugs", () => {
    expect(new Set(DOC_SLUGS).size).toBe(DOC_SLUGS.length);
  });

  it("every nav slug has a backing page.mdx", () => {
    for (const slug of DOC_SLUGS) {
      const file =
        slug === ""
          ? join(DOCS_DIR, "page.mdx")
          : join(DOCS_DIR, slug, "page.mdx");
      expect(existsSync(file), `missing page.mdx for slug "${slug}"`).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/docs/nav.test.ts`
Expected: FAIL — the `page.mdx` files don't exist yet (the "backing page.mdx" assertion fails). The "no duplicate slugs" case should already pass.

- [ ] **Step 3: Leave the test red for now**

This test goes green once the docs pages are created (Phase 4). Do NOT delete or weaken it. Note it as expected-red until Task 25.

- [ ] **Step 4: Commit**

```bash
git add src/lib/docs/nav.test.ts
git commit -m "test(docs): nav must stay in sync with page.mdx files (red until pages exist)"
```

### Task 8: Marketing header + route-group layout

**Files:**
- Create: `src/components/marketing/marketing-header.tsx`
- Create: `src/app/(marketing)/layout.tsx`

- [ ] **Step 1: Write `src/components/marketing/marketing-header.tsx`**

```tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV = [
  { href: "/docs", label: "Docs" },
  { href: "/use-cases", label: "Use cases" },
  { href: "/pricing", label: "Pricing" },
  { href: "/changelog", label: "Changelog" },
];

export function MarketingHeader({ signedIn }: { signedIn: boolean }) {
  const pathname = usePathname();
  return (
    <header className="marketing-header">
      <Link href="/" className="font-semibold">
        Odyhook
      </Link>
      <nav className="marketing-header-nav">
        {NAV.map((item) => {
          const active = pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={
                active
                  ? "font-medium text-zinc-900 dark:text-zinc-100"
                  : "text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
              }
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
      <span className="marketing-header-spacer" />
      <Link
        href={signedIn ? "/sources" : "/signin"}
        className="btn-primary-ody inline-flex h-9 items-center rounded-md px-4 text-sm font-medium"
      >
        {signedIn ? "Dashboard" : "Sign in"}
      </Link>
    </header>
  );
}
```

- [ ] **Step 2: Write `src/app/(marketing)/layout.tsx`**

```tsx
import Link from "next/link";

import { auth } from "@/auth";
import { MarketingHeader } from "@/components/marketing/marketing-header";
import { ThemeToggle } from "@/components/theme-toggle";

// Shared chrome for the public content surfaces (/docs, /use-cases, /pricing,
// /changelog). The landing page lives outside this group so it keeps its
// bespoke full-bleed layout. These routes are public — proxy.ts gates only
// the dashboard, so no auth wiring is needed beyond reading the session to
// pick the header CTA label.
export default async function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  const signedIn = !!session?.user;

  return (
    <div className="marketing-shell">
      <MarketingHeader signedIn={signedIn} />
      <main className="marketing-main">{children}</main>
      <footer className="landing-footer">
        <Link href="/">Odyhook</Link>
        <span className="landing-footer-sep">·</span>
        <span>Webhooks that don&rsquo;t silently fail.</span>
        <span className="landing-footer-spacer" />
        <ThemeToggle />
      </footer>
    </div>
  );
}
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(marketing)/layout.tsx" src/components/marketing/marketing-header.tsx
git commit -m "feat(marketing): public route-group chrome (header + footer)"
```

### Task 9: Docs sidebar + docs shell layout

**Files:**
- Create: `src/components/docs/docs-sidebar.tsx`
- Create: `src/app/(marketing)/docs/layout.tsx`

- [ ] **Step 1: Write `src/components/docs/docs-sidebar.tsx`**

```tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { DOCS_NAV, hrefForSlug } from "@/lib/docs/nav";

export function DocsSidebar() {
  const pathname = usePathname();
  return (
    <aside className="docs-sidebar">
      {DOCS_NAV.map((section) => (
        <div key={section.title} className="docs-sidebar-section">
          <h4>{section.title}</h4>
          {section.links.map((link) => {
            const href = hrefForSlug(link.slug);
            const active = pathname === href;
            return (
              <Link
                key={href}
                href={href}
                className={active ? "is-active" : undefined}
              >
                {link.title}
              </Link>
            );
          })}
        </div>
      ))}
    </aside>
  );
}
```

- [ ] **Step 2: Write `src/app/(marketing)/docs/layout.tsx`**

```tsx
import { DocsSidebar } from "@/components/docs/docs-sidebar";

export default function DocsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="docs-shell">
      <DocsSidebar />
      <article className="docs-prose">{children}</article>
    </div>
  );
}
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/docs/docs-sidebar.tsx "src/app/(marketing)/docs/layout.tsx"
git commit -m "feat(docs): docs shell layout + sidebar"
```

---

## Phase 2 — Marketing pages (hand-designed TSX)

### Task 10: Pricing page

**Files:**
- Create: `src/app/(marketing)/pricing/page.tsx`

**Grounding:** cost table in `infra/README.md` ("Cost breakdown"). Message = "self-hosted = free; BYOK; you pay only for your own server + Anthropic usage."

- [ ] **Step 1: Write `src/app/(marketing)/pricing/page.tsx`**

```tsx
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Pricing — Odyhook",
  description:
    "Odyhook is self-hosted and free. Bring your own Anthropic key; pay only for your own server.",
};

const COSTS = [
  { item: "Hetzner CX23 server (2 vCPU, 4 GB)", cost: "~€4.95 / mo" },
  { item: "Domain (annual, amortized)", cost: "~€1.07 / mo" },
  { item: "Resend email (free tier)", cost: "€0" },
  { item: "Cloudflare R2 backups (free tier)", cost: "€0" },
  { item: "Sentry (free tier)", cost: "€0" },
  { item: "Anthropic API (BYOK — your usage)", cost: "you pay Anthropic directly" },
];

export default function PricingPage() {
  return (
    <>
      <h1 className="marketing-h1">Free, because you host it.</h1>
      <p className="marketing-lede">
        Odyhook is self-hosted and open source. There is no Odyhook bill — you
        run it on your own box and bring your own Anthropic key for the AI
        features. Here&rsquo;s what a real production deployment actually costs.
      </p>

      <table className="docs-prose" style={{ marginTop: "2rem" }}>
        <thead>
          <tr>
            <th>Line item</th>
            <th>Cost</th>
          </tr>
        </thead>
        <tbody>
          {COSTS.map((row) => (
            <tr key={row.item}>
              <td>{row.item}</td>
              <td>{row.cost}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="marketing-lede" style={{ marginTop: "1.5rem" }}>
        Total ongoing: <strong>~€6 / month</strong> for the whole stack.
      </p>

      <div style={{ marginTop: "2rem" }}>
        <Link
          href="/docs/quickstart"
          className="btn-primary-ody inline-flex h-11 items-center rounded-md px-5 text-sm font-medium"
        >
          Deploy your own →
        </Link>
      </div>
    </>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Verify the page renders**

Run: `npm run dev`, open `http://localhost:3000/pricing`.
Expected: table + CTA render with the marketing header/footer; reachable without signing in.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(marketing)/pricing/page.tsx"
git commit -m "feat(marketing): pricing page"
```

### Task 11: Use-cases page

**Files:**
- Create: `src/app/(marketing)/use-cases/page.tsx`

**Grounding:** the three scenarios from the spec; commands grounded in CLI README and the ingest/filter surface.

- [ ] **Step 1: Write `src/app/(marketing)/use-cases/page.tsx`**

```tsx
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Use cases — Odyhook",
  description:
    "Three concrete things people do with Odyhook: local webhook dev, GitHub→Slack filtering, and fan-out.",
};

const CASES = [
  {
    id: "local-dev",
    title: "Stripe webhooks on your laptop",
    blurb:
      "Receive real provider webhooks against localhost without ngrok. The ody CLI streams events to your machine and replays them at your local server.",
    steps: [
      "Create a source (e.g. stripe-prod) and point Stripe at its ingest URL.",
      "ody listen --source stripe-prod --forward http://localhost:3000/webhook",
      "Every event is stored forever — replay any of them with ody trigger --replay.",
    ],
  },
  {
    id: "github-slack",
    title: "GitHub PRs → Slack, filtered",
    blurb:
      "Forward only the GitHub events you care about. Describe the filter in plain English; it compiles to JS that runs in a sandbox before forwarding.",
    steps: [
      "Create a github source and a Slack-webhook destination.",
      "Add a route and an AI-compiled filter: “only pushes to main”.",
      "Odyhook verifies the GitHub signature, filters, and forwards with retries.",
    ],
  },
  {
    id: "fan-out",
    title: "Fan out one webhook to many",
    blurb:
      "One inbound signup event, multiple downstreams. Each destination retries independently and can be paused or auto-disabled on failure.",
    steps: [
      "Create one source and three destinations (Postgres relay, email, analytics).",
      "Add three routes from the source — one per destination.",
      "Each delivery is tracked, retried, and replayable on its own.",
    ],
  },
];

export default function UseCasesPage() {
  return (
    <>
      <h1 className="marketing-h1">What people build with Odyhook</h1>
      <p className="marketing-lede">
        Three patterns that cover most webhook plumbing. Each is a few minutes
        of setup.
      </p>

      <div className="marketing-card-grid">
        {CASES.map((c) => (
          <section key={c.id} id={c.id} className="marketing-card">
            <h2 style={{ fontSize: "1.2rem", fontWeight: 700 }}>{c.title}</h2>
            <p style={{ color: "var(--fg-2)", margin: "0.5rem 0 1rem" }}>
              {c.blurb}
            </p>
            <ol style={{ paddingLeft: "1.1rem", fontSize: "0.9rem", lineHeight: 1.6 }}>
              {c.steps.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ol>
          </section>
        ))}
      </div>

      <p className="marketing-lede">
        Full setup walkthroughs live in the{" "}
        <Link href="/docs/quickstart" style={{ color: "var(--brand-blue)" }}>
          Quickstart
        </Link>
        .
      </p>
    </>
  );
}
```

- [ ] **Step 2: Type-check + render**

Run: `npx tsc --noEmit` then open `http://localhost:3000/use-cases`.
Expected: three cards render, public.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(marketing)/use-cases/page.tsx"
git commit -m "feat(marketing): use-cases page"
```

---

## Phase 3 — Changelog

### Task 12: Changelog page

**Files:**
- Create: `src/app/(marketing)/changelog/page.mdx`

**Grounding:** reconstruct entries from the merged PRs recorded in the gap-analysis plan and git log (#4 metrics, #5 REST API, #6 CLI, #7 fixtures, #8 AI diffs, #9 MCP, #10 NL search). Use approximate month/year dates already in the plan's progress snapshot; do not invent exact days you can't verify — use the PR groupings.

- [ ] **Step 1: Write `src/app/(marketing)/changelog/page.mdx`**

```mdx
export const metadata = {
  title: "Changelog — Odyhook",
  description: "What shipped, newest first.",
};

# Changelog

Newest first. Each entry maps to a merged pull request.

## Natural-language event search

Search events in plain English from the dashboard, the REST API
(`POST /api/v1/events/search`), and the `search_events` MCP tool — one
compile-then-run engine. _(PR #10)_

## MCP server

A stateless Streamable-HTTP endpoint at `POST /api/mcp`, authenticated with an
`ody_` API token. Exposes read and safe-write tools over the service layer,
including the BYOK `compile_filter` tool. No delete tools. _(PR #9)_

## AI-explained event diffs

Compare two payloads and get a plain-English summary of what changed, cached
per event pair. _(PR #8)_

## AI-generated test fixtures

`ody trigger --generate "<description>"` produces a realistic payload from a
plain-English description and delivers it through the normal ingest path.
_(PR #7)_

## CLI (`ody`)

`ody listen` streams events to your laptop over SSE and forwards them to a
local URL; `ody trigger` sends or replays events. _(PR #6)_

## Public REST API

`/api/v1` CRUD for sources, destinations, routes, and events, with API-token
auth, cursor pagination, and an OpenAPI spec at `/openapi.json`. _(PR #5)_

## Metrics dashboard

Throughput, success-rate, and latency widgets on the overview, source, and
destination pages. _(PR #4)_
```

- [ ] **Step 2: Verify it renders**

Run: open `http://localhost:3000/changelog`.
Expected: rendered MDX with the marketing chrome, public.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(marketing)/changelog/page.mdx"
git commit -m "feat(marketing): changelog page"
```

---

## Phase 4 — Docs pages

> **Per-page recipe (applies to every task below):**
> 1. Re-read the named grounding file(s) and confirm the facts before writing.
> 2. Create `src/app/(marketing)/docs/<slug>/page.mdx` (or `docs/page.mdx` for the index) starting with an `export const metadata = { title, description }` block, then an `# H1`, then the required sections.
> 3. Use fenced code blocks (```` ```bash ````, ```` ```ts ````) — Shiki highlights them automatically. Use `<Callout>` / `<CodeTabs>` where noted.
> 4. Verify the route renders at `http://localhost:3000/docs/<slug>`.
> 5. Commit: `git add <file> && git commit -m "docs: <slug> page"`.

### Task 13: Docs index (`docs/page.mdx`)

**Files:** Create `src/app/(marketing)/docs/page.mdx`

- [ ] **Required sections:** H1 "Odyhook docs"; one-paragraph description of Odyhook (from `infra/README.md` one-paragraph version); a "Start here" link to `/docs/quickstart`; a short bulleted map of the four sidebar sections with links (use the titles from `src/lib/docs/nav.ts`). No code blocks needed. Commit.

### Task 14: Quickstart (`docs/quickstart/page.mdx`)

**Files:** Create `src/app/(marketing)/docs/quickstart/page.mdx`
**Grounding:** `src/app/api/ingest/[slug]/route.ts`, dashboard source/destination/route flow.

- [ ] **Required sections:**
  1. "Create a source" — sign in, create a source, copy its ingest URL.
  2. "Send a test event" — a `bash` fenced block:
     ```bash
     curl -X POST https://odyhook.dev/api/ingest/<your-slug> \
       -H "content-type: application/json" \
       -d '{"hello":"world"}'
     ```
  3. "See it in the dashboard" — events are stored raw, forever.
  4. "Wire a destination + route" — create a destination URL, add a route from source→destination; the worker forwards with retries.
  5. A `<Callout type="note">` that local dev sends magic-link email to MailHog at `http://localhost:8025`.
  Verify + commit.

### Task 15: Signature verification (`docs/signature-verification/page.mdx`)

**Files:** Create `src/app/(marketing)/docs/signature-verification/page.mdx`
**Grounding:** `src/lib/hmac.ts` (`verifyStripe`, `verifySha256`, `verifySignature`, `VerifyStyle`).

- [ ] **Required sections:**
  1. Intro: Odyhook verifies inbound signatures before persisting. Three styles.
  2. A table of the three styles with the exact header each reads:
     - `stripe` → `Stripe-Signature: t=…,v1=…` (signed value `` `${t}.${rawBody}` ``, 300s tolerance).
     - `github` → `x-hub-signature-256` (`sha256=` + hex of HMAC-SHA256 over the raw body).
     - `generic-sha256` → `x-signature-256` or `x-signature` (hex of HMAC-SHA256 over the raw body).
  3. A `<Callout type="warning">`: signatures are computed over the **raw** request body — verify before any JSON re-serialization.
  Verify + commit.

### Task 16: Outbound HMAC (`docs/outbound-hmac/page.mdx`)

**Files:** Create `src/app/(marketing)/docs/outbound-hmac/page.mdx`
**Grounding:** `src/lib/outbound-sign.ts`.

- [ ] **Required sections:**
  1. Explain: each delivery is signed with the per-destination secret. Headers `X-Odyhook-Signature: v1=<hex>` and `X-Odyhook-Timestamp`. Signed value is `` `${timestamp}.${rawBody}` `` (HMAC-SHA256, hex).
  2. A `<CodeTabs>` with verify snippets in **Node, Python, Go**. Node tab (verbatim — others mirror it):
     ```ts
     import crypto from "node:crypto";

     function verify(rawBody: string, sigHeader: string, tsHeader: string, secret: string) {
       const sig = sigHeader.replace(/^v1=/, "");
       const expected = crypto
         .createHmac("sha256", secret)
         .update(`${tsHeader}.${rawBody}`, "utf8")
         .digest("hex");
       return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
     }
     ```
  3. A `<Callout type="note">`: reject requests whose `X-Odyhook-Timestamp` is too old to prevent replay.
  Verify + commit.

### Task 17: Retries & backoff (`docs/retries-and-backoff/page.mdx`)

**Files:** Create `src/app/(marketing)/docs/retries-and-backoff/page.mdx`
**Grounding:** `src/lib/queue.ts` (`RETRY_DELAYS_MS`, `MAX_ATTEMPTS`), `src/workers/delivery.ts`.

- [ ] **Required sections:**
  1. Explain: failed deliveries retry on a fixed exponential schedule; 6 attempts total (1 initial + 5 retries). Exhausted deliveries stay visible for one-click replay.
  2. A table of the schedule (delay before each retry): `10s, 30s, 2m, 10m, 1h, 6h`.
  3. Note that terminal (non-retryable) outcomes stop early.
  Verify + commit.

### Task 18: Rate limits (`docs/rate-limits/page.mdx`)

**Files:** Create `src/app/(marketing)/docs/rate-limits/page.mdx`
**Grounding:** `src/lib/ratelimit.ts`, `src/app/api/ingest/[slug]/route.ts`.

- [ ] **Required sections:**
  1. Token-bucket per source; default refill/burst from env (`RATE_LIMIT_PER_SEC` / `RATE_LIMIT_BURST`, default 10/20) with optional per-source override.
  2. On limit: HTTP `429` with headers `Retry-After` (seconds) and `X-RateLimit-Remaining: 0`. Describe ONLY these two headers.
  3. Note the separate API-token rate limit for `/api/v1` (`API_RATE_LIMIT_PER_SEC` / `API_RATE_LIMIT_BURST`, default 10/30).
  Verify + commit.

### Task 19: Idempotency (`docs/idempotency/page.mdx`)

**Files:** Create `src/app/(marketing)/docs/idempotency/page.mdx`
**Grounding:** `src/lib/idempotency.ts`, `prisma/schema.prisma` (`Event.idempotencyKey`, `@@unique([sourceId, idempotencyKey])`).

- [ ] **Required sections:**
  1. Explain dedupe key derivation order: `Idempotency-Key` header → Stripe `event.id` → GitHub `X-GitHub-Delivery` → `sha256(body)`.
  2. Behavior: a duplicate `(sourceId, key)` returns the prior event instead of inserting again, so downstreams aren't double-fired.
  3. `<Callout type="note">`: providers re-send on their own retries — this is what stops fan-out duplicates.
  Verify + commit. **Re-read `src/lib/idempotency.ts` to confirm the exact key order before writing.**

### Task 20: CLI (`docs/cli/page.mdx`)

**Files:** Create `src/app/(marketing)/docs/cli/page.mdx`
**Grounding:** `cli/README.md`, `cli/src/index.ts`.

- [ ] **Required sections:**
  1. Install + auth: an `ody_` API token from Settings → API Tokens.
  2. `ody listen` — `bash` block: `ody listen --source gh-prod --forward http://localhost:3000/webhook --since 1h`. Explain SSE stream + missed-event backfill.
  3. `ody trigger` — `bash` block with `--data @file`, `--header`, `--replay evt_…`, `--generate "desc"`, `--dry-run`.
  Verify + commit.

### Task 21: REST API (`docs/rest-api/page.mdx`)

**Files:** Create `src/app/(marketing)/docs/rest-api/page.mdx`
**Grounding:** `src/app/api/v1/*`, `/openapi.json`.

- [ ] **Required sections:**
  1. Auth: `Authorization: Bearer ody_…` token from Settings → API Tokens.
  2. Resource table: `sources`, `destinations`, `routes`, `events` (list/create + `[id]` get/update), plus `events/search`, `fixtures`. Cursor pagination.
  3. Link to the machine-readable spec at `/openapi.json`.
  4. A `bash` example: `curl -H "Authorization: Bearer ody_…" https://odyhook.dev/api/v1/sources`.
  Verify + commit.

### Task 22: MCP server (`docs/mcp/page.mdx`)

**Files:** Create `src/app/(marketing)/docs/mcp/page.mdx`
**Grounding:** `src/lib/mcp/tools.ts`, `src/app/api/mcp/route.ts`.

- [ ] **Required sections:**
  1. What it is: stateless Streamable-HTTP MCP endpoint at `POST /api/mcp`, `ody_`-token auth.
  2. Tool surface: read tools (`list_sources`, `get_source`, `list_destinations`, `get_destination`, `list_routes`, `get_route`, `list_events`, `get_event`, `list_deliveries`) and safe-write tools (`create_route`, `set_route_filter`, `pause_destination`, `compile_filter`, `search_events`, source/destination create/update). **Re-read `tools.ts` to list the exact tool names.**
  3. `<Callout type="note">`: no delete tools by design.
  4. Example: connecting from Claude Code with the endpoint URL + token.
  Verify + commit.

### Task 23: AI filters & transforms (`docs/ai-filters-and-transforms/page.mdx`)

**Files:** Create `src/app/(marketing)/docs/ai-filters-and-transforms/page.mdx`
**Grounding:** `src/lib/ai/`, `src/lib/sandbox/`, `src/lib/filters/`, Settings → API Keys (BYOK).

- [ ] **Required sections:**
  1. BYOK: paste your Anthropic key in Settings → API Keys (encrypted at rest).
  2. Filters: describe a condition in English → compiles to a filter that decides whether to forward.
  3. Transforms: describe a payload reshape → compiles to JS that runs in a QuickJS sandbox before delivery.
  3. `<Callout type="note">`: AI features require your own Anthropic key; no central key.
  Verify + commit.

### Task 24: Natural-language event search (`docs/nl-event-search/page.mdx`)

**Files:** Create `src/app/(marketing)/docs/nl-event-search/page.mdx`
**Grounding:** `src/lib/search/`, `src/lib/ai/search-compiler.ts`, `src/app/api/v1/events/search/route.ts`.

- [ ] **Required sections:**
  1. What it does: English query → compiled structured query → executed (source/time/delivery-status as SQL `WHERE`; payload-content predicates scanned in-memory against `Event.bodyRaw` up to a cap, with cursor pagination).
  2. Where to use it: dashboard `/events` search box, `POST /api/v1/events/search`, and the `search_events` MCP tool — one engine.
  3. `bash` example posting `{ "q": "events from the last day where the delivery failed" }` to `/api/v1/events/search` with a Bearer token.
  Verify + commit.

### Task 25: AI event diffs (`docs/ai-event-diffs/page.mdx`)

**Files:** Create `src/app/(marketing)/docs/ai-event-diffs/page.mdx`
**Grounding:** `/events/compare` page, `AiEventDiff` model in `prisma/schema.prisma`.

- [ ] **Required sections:**
  1. What it does: pick two events → Claude explains what changed in plain English.
  2. Where: the `/events/compare` page and the "Compare with AI" bulk action on the events page.
  3. Note results are cached per event-pair (`AiEventDiff`), BYOK.
  4. **After committing this page, run the nav test (Task 7) — it should now be GREEN.**

  Run: `npx vitest run src/lib/docs/nav.test.ts`
  Expected: PASS (all 13 slugs now have backing `page.mdx`).
  Verify + commit.

---

## Phase 5 — Cross-linking & final verification

### Task 26: Link the new surfaces from the homepage footer + final gate

**Files:**
- Modify: `src/app/page.tsx` (footer area, around lines 135–147)

- [ ] **Step 1: Add nav links to the landing footer**

In `src/app/page.tsx`, inside the existing `<footer className="landing-footer">`, add a set of links before the `<span className="landing-footer-spacer" />`:
```tsx
<Link href="/docs" className="landing-footer-link">Docs</Link>
<Link href="/use-cases" className="landing-footer-link">Use cases</Link>
<Link href="/pricing" className="landing-footer-link">Pricing</Link>
<Link href="/changelog" className="landing-footer-link">Changelog</Link>
```
(`Link` is already imported in `page.tsx`. Add a minimal `.landing-footer-link { color: var(--fg-2); }` rule to `globals.css` if the links need spacing/color; otherwise reuse existing footer styles.)

- [ ] **Step 2: Full type-check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Full test run**

Run: `npm run test`
Expected: PASS, including `src/lib/docs/nav.test.ts`.

- [ ] **Step 4: Production build (the primary SSG gate)**

Run: `npm run build`
Expected: PASS — every `page.mdx` renders at build time. A broken MDX file, bad custom-component reference, or plugin misconfig fails here.

- [ ] **Step 5: Manual public-access check**

Run: `npm run dev`. While **signed out**, visit `/docs`, a few doc subpages, `/use-cases`, `/pricing`, `/changelog`. Confirm: sidebar active-highlight works, code blocks are syntax-highlighted, dark mode toggles, mobile width collapses the docs grid to one column, and none of the pages redirect to `/signin`.

- [ ] **Step 6: Commit**

```bash
git add src/app/page.tsx src/app/globals.css
git commit -m "feat(marketing): link docs/use-cases/pricing/changelog from homepage footer"
```

---

## Self-Review

**1. Spec coverage:**
- MDX pipeline (Tasks 1–4) ✓ · Public chrome / public-by-default (Task 8) ✓ · Docs shell + sidebar + nav SoT (Tasks 6, 9) ✓ · 13 docs pages incl. core + CLI/REST/MCP + AI (Tasks 13–25) ✓ · Changelog (Task 12) ✓ · Pricing (Task 10) ✓ · Use-cases (Task 11) ✓ · Shiki highlighting + Callout + CodeTabs (Tasks 2, 4) ✓ · nav test + build gate (Tasks 7, 26) ✓ · Grounding rule enforced per page ✓ · Non-goals (search/versioning/i18n/comparison pages) not introduced ✓.

**2. Placeholder scan:** Engineering tasks (Phases 0–3, 5) carry complete code. Phase 4 doc tasks specify exact file, grounding file, required sections, and the must-be-exact snippets/tables/headers — content prose is authored against the named source files (the appropriate division for docs), not left as "TODO".

**3. Type consistency:** `DOCS_NAV`/`DOC_SLUGS`/`hrefForSlug` (Task 6) are consumed unchanged in Tasks 7 and 9. `Callout`/`CodeTabs` signatures (Task 4) match their usage in `mdx-components.tsx` (Task 3) and the doc tasks. `MarketingHeader({ signedIn })` (Task 8) matches its call site. Route-group path `src/app/(marketing)/docs/...` matches the nav test's `DOCS_DIR`.

**Note on build order:** Task 4 (Callout/CodeTabs) must run before Task 3 (mdx-components imports them) — called out inline in both tasks.
