import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Sub-processors — Odyhook",
  description:
    "The infrastructure providers the hosted Odyhook service relies on, what data each one processes, and where.",
};

// Last updated — bump whenever a provider is added or removed.
const UPDATED = "8 June 2026";

const SUBPROCESSORS = [
  {
    name: "Hetzner Online GmbH",
    role: "Cloud hosting / compute & primary storage",
    data: "All data — the app, Postgres, and Redis run on one Hetzner server.",
    location: "Helsinki, Finland (EU)",
  },
  {
    name: "Resend (Plusten, Inc.) via AWS SES",
    role: "Transactional email (magic links, alerts, digests)",
    data: "Your account email address and the contents of those emails.",
    location: "USA / EU",
  },
  {
    name: "Cloudflare, Inc. (R2)",
    role: "Off-site encrypted database backups",
    data: "Nightly Postgres dump — includes stored webhook payloads.",
    location: "EU (EEUR region)",
  },
  {
    name: "Functional Software, Inc. (Sentry)",
    role: "Error tracking for the web app and worker",
    data:
      "Exception traces. Request bodies, cookies, query strings, and sensitive headers are scrubbed before sending.",
    location: "Germany (EU)",
  },
  {
    name: "Your chosen AI provider (Anthropic, OpenAI, Google, or OpenRouter)",
    role: "AI features (filter/transform compilation, failure diagnosis, NL search, event diffs, fixtures) — only when you use them",
    data:
      "Event payloads you submit to an AI feature, sent using your own (bring-your-own) key for the provider you configured. Keys are billed to you directly; Odyhook holds no central AI key.",
    location: "Varies by provider (USA for all four options)",
  },
  {
    name: "GitHub, Inc.",
    role: "Optional “Continue with GitHub” sign-in",
    data: "Only if you use it: your GitHub name, email, and avatar URL.",
    location: "USA",
  },
];

export default function SubprocessorsPage() {
  return (
    <div className="docs-prose">
      <h1 className="marketing-h1">Sub-processors</h1>
      <p className="marketing-lede">
        To run the hosted Odyhook service we rely on the infrastructure providers
        below. Each processes the data shown for the stated purpose. This list
        applies only to the hosted service at <code>odyhook.dev</code> &mdash; if
        you <Link href="/docs/quickstart">self-host</Link>, you choose your own
        providers and this list does not apply.
      </p>
      <p>
        <em>Last updated: {UPDATED}.</em>
      </p>

      <table>
        <thead>
          <tr>
            <th>Provider</th>
            <th>Role</th>
            <th>Data processed</th>
            <th>Location</th>
          </tr>
        </thead>
        <tbody>
          {SUBPROCESSORS.map((p) => (
            <tr key={p.name}>
              <td>{p.name}</td>
              <td>{p.role}</td>
              <td>{p.data}</td>
              <td>{p.location}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p>
        We will update this page before adding a new sub-processor that handles
        personal data. A Data Processing Agreement is available on request &mdash;
        email <a href="mailto:ngkdev93@gmail.com">ngkdev93@gmail.com</a>.
      </p>

      <p style={{ marginTop: "2.5rem", fontSize: "0.9rem" }}>
        <Link href="/privacy">Privacy Policy</Link> ·{" "}
        <Link href="/terms">Terms of Service</Link> ·{" "}
        <Link href="/security">Security</Link>
      </p>
    </div>
  );
}
