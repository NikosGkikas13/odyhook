import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Security — Odyhook",
  description:
    "How to report a vulnerability in Odyhook, and the security posture of the hosted service.",
};

const ADVISORY_URL =
  "https://github.com/NikosGkikas13/odyhook/security/advisories/new";

export default function SecurityPage() {
  return (
    <div className="docs-prose">
      <h1 className="marketing-h1">Security</h1>
      <p className="marketing-lede">
        Odyhook is open source and the hosted service is operated by a single
        individual. We welcome responsible disclosure of security issues.
      </p>

      <h2>Reporting a vulnerability</h2>
      <p>
        Please report security issues <strong>privately</strong> &mdash; don&rsquo;t
        open a public GitHub issue for a vulnerability.
      </p>
      <ul>
        <li>
          Preferred:{" "}
          <a href={ADVISORY_URL} target="_blank" rel="noreferrer">
            GitHub private vulnerability reporting
          </a>
          .
        </li>
        <li>
          Alternative:{" "}
          <a href="mailto:ngkdev93@gmail.com">ngkdev93@gmail.com</a>.
        </li>
      </ul>
      <p>
        Include enough detail to reproduce: affected endpoint or file, steps, and
        impact. A machine-readable contact is published at{" "}
        <a href="/.well-known/security.txt">/.well-known/security.txt</a>.
      </p>

      <h2>What to expect</h2>
      <p>
        Best-effort acknowledgement within 5 days (this is a solo-operated
        project, so response times aren&rsquo;t guaranteed), then triage, a fix,
        and credit with your consent.
      </p>

      <h2>Scope</h2>
      <p>
        In scope: the hosted service at <code>odyhook.dev</code> and the source
        code in the repository. Out of scope: denial-of-service / volumetric
        testing, social engineering, attacks on third-party{" "}
        <Link href="/subprocessors">sub-processors</Link>, and automated-scanner
        output with no demonstrated impact.
      </p>

      <h2>Security posture</h2>
      <ul>
        <li>
          Secrets (signing secrets, destination headers, BYOK Anthropic keys) are
          encrypted at rest with AES-256-GCM.
        </li>
        <li>
          Outbound delivery is SSRF-protected (scheme/IP checks,
          resolve-and-pin, manual redirect handling).
        </li>
        <li>
          Inbound HMAC verification is constant-time; request bodies are
          size-capped.
        </li>
        <li>
          Sentry traces are scrubbed of bodies, cookies, query strings, and
          sensitive headers before sending.
        </li>
        <li>
          The code is open source and auditable. For the strongest isolation,{" "}
          <Link href="/docs/quickstart">self-host</Link> &mdash; your data never
          touches our infrastructure.
        </li>
      </ul>

      <p style={{ marginTop: "2.5rem", fontSize: "0.9rem" }}>
        <Link href="/privacy">Privacy Policy</Link> ·{" "}
        <Link href="/terms">Terms of Service</Link> ·{" "}
        <Link href="/subprocessors">Sub-processors</Link>
      </p>
    </div>
  );
}
