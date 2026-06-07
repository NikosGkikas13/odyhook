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
      "Every event is stored for your configured retention window — replay any of them with ody trigger --replay.",
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
