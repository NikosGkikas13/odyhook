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
