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
      { slug: "api-reference", title: "API reference" },
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
