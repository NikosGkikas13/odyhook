// Competitor comparison data for /vs/hookdeck and /vs/svix.
// All claims verified as of June 2026 against the linked sources. Tone: factual,
// non-smug, competitor strengths stated plainly. When competitor facts change,
// update the cells, the prose, and the `asOf` stamp together.

export type CellValue = "yes" | "no" | "partial";
export type Cell = { value: CellValue; note?: string };
export type FeatureRow = {
  capability: string;
  odyhook: Cell;
  competitor: Cell;
};

export type Comparison = {
  slug: string;
  competitor: string;
  asOf: string;
  positioning: string;
  features: FeatureRow[];
  competitorStrengths: string[];
  pickOdyhookIf: string[];
  pickCompetitorIf: string[];
  sources: { label: string; url: string }[];
};

const yes = (note?: string): Cell => ({ value: "yes", note });
const no = (note?: string): Cell => ({ value: "no", note });
const partial = (note?: string): Cell => ({ value: "partial", note });

const hookdeck: Comparison = {
  slug: "hookdeck",
  competitor: "Hookdeck",
  asOf: "June 2026",
  positioning:
    "Hookdeck's Event Gateway is a hosted (SaaS) webhook gateway for receiving and routing events — the product that overlaps most with Odyhook. Its separate Outpost product (Apache-2.0, self-hostable) is for sending webhooks. Odyhook is a single self-hosted receiver/router you run on your own box for a flat cost, with BYOK AI built in. Hookdeck is more mature and has a far larger catalog of preconfigured sources and destinations; Odyhook trades that breadth for self-hosting, a flat bill, and AI-native tooling.",
  features: [
    {
      capability: "Self-hosted",
      odyhook: yes("You run it on your own server."),
      competitor: partial("Event Gateway is SaaS-only; Outpost (sending) is self-hostable."),
    },
    {
      capability: "Open source",
      odyhook: yes(),
      competitor: partial("Outpost is Apache-2.0; the Event Gateway is not."),
    },
    {
      capability: "Pricing model",
      odyhook: yes("Flat ~€6/mo: your server + BYOK, no per-event fees."),
      competitor: no("Free → $39/mo → $499/mo tiers plus per-event overage."),
    },
    {
      capability: "Inbound signature verification",
      odyhook: yes("Stripe, GitHub, generic SHA-256."),
      competitor: yes("Verifies provider signatures."),
    },
    {
      capability: "Outbound HMAC signing",
      odyhook: yes("Per-destination secret, signed headers."),
      competitor: yes(),
    },
    {
      capability: "Retries with backoff",
      odyhook: yes("10s → 30s → 2m → 10m → 1h → 6h."),
      competitor: yes("Durable queue with retries."),
    },
    {
      capability: "Idempotency / dedup",
      odyhook: yes("Per-source idempotency key."),
      competitor: yes("Field-based deduplication."),
    },
    {
      capability: "Filtering",
      odyhook: yes("JSONPath + AI-compiled filters."),
      competitor: yes("Advanced filtering."),
    },
    {
      capability: "Transformations",
      odyhook: yes("Sandboxed JS (QuickJS)."),
      competitor: yes("Transformations."),
    },
    {
      capability: "Replay",
      odyhook: yes("Single + bulk replay."),
      competitor: yes(),
    },
    {
      capability: "Local-dev forwarding (CLI)",
      odyhook: yes("ody listen streams events to localhost."),
      competitor: yes("Hookdeck CLI forwards to localhost."),
    },
    {
      capability: "MCP / AI-agent tools",
      odyhook: yes("Stateless MCP server over the API."),
      competitor: partial("Markets MCP & Agent Skills."),
    },
    {
      capability: "BYOK AI (filters, diagnosis, NL search, diffs)",
      odyhook: yes("Bring your own Anthropic key."),
      competitor: no(),
    },
    {
      capability: "Preconfigured source catalog",
      odyhook: no("Generic sources; you configure them."),
      competitor: yes("120+ preconfigured sources."),
    },
    {
      capability: "Non-HTTP destinations (Kafka/SQS/…)",
      odyhook: no("HTTPS destinations only."),
      competitor: yes("Via Outpost: SQS, Kafka, Pub/Sub, etc."),
    },
    {
      capability: "Enterprise compliance (SOC 2 / SSO / SLA)",
      odyhook: no("Solo self-hosted; no compliance program."),
      competitor: yes("SOC 2; SSO/SAML/SCIM + SLAs on higher tiers."),
    },
  ],
  competitorStrengths: [
    "120+ preconfigured sources and a broad destination catalog (incl. Kafka/SQS via Outpost).",
    "Enterprise compliance: SOC 2, SSO/SAML/SCIM, uptime/latency SLAs.",
    "A mature, fully managed service — nothing to operate.",
    "Visual tracing, full-text search, and issue tracking out of the box.",
  ],
  pickOdyhookIf: [
    "You want to self-host and keep webhook data on your own infrastructure.",
    "You want a flat, predictable bill instead of per-event pricing.",
    "You want AI-native filtering, diagnosis, and search with your own Anthropic key.",
  ],
  pickCompetitorIf: [
    "You need a managed service with enterprise compliance (SOC 2, SSO, SLAs).",
    "You need a large catalog of preconfigured sources or non-HTTP destinations.",
    "You'd rather not operate any infrastructure yourself.",
  ],
  sources: [
    { label: "Hookdeck pricing", url: "https://hookdeck.com/pricing" },
    { label: "Hookdeck Outpost (open source)", url: "https://github.com/hookdeck/outpost" },
  ],
};

const svix: Comparison = {
  slug: "svix",
  competitor: "Svix",
  asOf: "June 2026",
  positioning:
    "Svix is an open-source (MIT) webhooks service focused on sending webhooks — it helps a SaaS deliver events to its own customers, with an embeddable customer-facing portal as its flagship. Odyhook solves the other side: receiving webhooks from providers and routing them to your destinations, self-hosted, with BYOK AI. Both can be self-hosted, but they target different jobs. If you're building a product that sends webhooks to your users, Svix is purpose-built for that; if you're routing inbound webhooks for yourself, Odyhook fits better.",
  features: [
    {
      capability: "Self-hosted",
      odyhook: yes("You run it on your own server."),
      competitor: yes("MIT server self-hostable; portal UI is SaaS-only."),
    },
    {
      capability: "Open source",
      odyhook: yes(),
      competitor: yes("MIT-licensed server."),
    },
    {
      capability: "Pricing model (SaaS)",
      odyhook: yes("Flat ~€6/mo: your server + BYOK."),
      competitor: no("Free → $490/mo → custom, per attempted message."),
    },
    {
      capability: "Primary direction",
      odyhook: yes("Receive & route inbound webhooks."),
      competitor: partial("Built to send webhooks to your users."),
    },
    {
      capability: "Inbound signature verification",
      odyhook: yes("Stripe, GitHub, generic SHA-256."),
      competitor: partial("Verification is on the consumer side of its sending model."),
    },
    {
      capability: "Outbound HMAC signing",
      odyhook: yes(),
      competitor: yes("Signs outgoing messages."),
    },
    {
      capability: "Retries with backoff",
      odyhook: yes("10s → 30s → 2m → 10m → 1h → 6h."),
      competitor: yes(),
    },
    {
      capability: "Filtering",
      odyhook: yes("JSONPath + AI-compiled filters."),
      competitor: yes("Event-type filtering."),
    },
    {
      capability: "Transformations",
      odyhook: yes("Sandboxed JS (QuickJS)."),
      competitor: yes("Transformations."),
    },
    {
      capability: "Replay",
      odyhook: yes("Single + bulk replay."),
      competitor: yes("Recover/replay failed messages."),
    },
    {
      capability: "Embeddable customer portal",
      odyhook: no("Not a sender product; no end-user portal."),
      competitor: yes("Flagship embeddable app portal (SaaS)."),
    },
    {
      capability: "Local-dev forwarding (CLI)",
      odyhook: yes("ody listen streams events to localhost."),
      competitor: partial("Svix Play test inbox; no localhost-forwarding CLI."),
    },
    {
      capability: "MCP / AI-agent tools",
      odyhook: yes("Stateless MCP server over the API."),
      competitor: no(),
    },
    {
      capability: "BYOK AI (filters, diagnosis, NL search, diffs)",
      odyhook: yes("Bring your own Anthropic key."),
      competitor: no(),
    },
    {
      capability: "Enterprise compliance (SOC 2 / SSO / SLA)",
      odyhook: no("Solo self-hosted; no compliance program."),
      competitor: yes("SOC 2 Type II, SSO, on-prem, 99.99–99.999% SLAs."),
    },
  ],
  competitorStrengths: [
    "Purpose-built for sending webhooks to your own users, with an embeddable portal.",
    "Mature, MIT-licensed Rust server with a well-documented API and SDKs.",
    "Enterprise tier: SOC 2 Type II, SSO, on-prem, audit logs, high SLAs.",
    "Generous free SaaS tier (50k attempted messages/mo).",
  ],
  pickOdyhookIf: [
    "You're receiving and routing inbound webhooks rather than sending them to customers.",
    "You want a flat self-hosted bill and BYOK AI tooling.",
    "You want one box to ingest, verify, filter, transform, and forward.",
  ],
  pickCompetitorIf: [
    "You're a SaaS that needs to send webhooks to your customers.",
    "You want an embeddable, white-label customer portal.",
    "You need enterprise compliance (SOC 2, SSO, on-prem, high SLAs).",
  ],
  sources: [
    { label: "Svix pricing", url: "https://www.svix.com/pricing/" },
    { label: "Svix open-source server", url: "https://github.com/svix/svix-webhooks" },
  ],
};

export const COMPARISONS: Comparison[] = [hookdeck, svix];

export function getComparison(slug: string): Comparison | undefined {
  return COMPARISONS.find((c) => c.slug === slug);
}
