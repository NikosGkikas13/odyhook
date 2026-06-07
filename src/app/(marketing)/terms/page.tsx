import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Terms of Service — Odyhook",
  description:
    "Terms governing use of the hosted Odyhook service: acceptable use, warranty disclaimer, limitation of liability, and termination.",
};

// Last updated — bump whenever the substance below changes.
const UPDATED = "7 June 2026";

export default function TermsPage() {
  return (
    <div className="docs-prose">
      <h1 className="marketing-h1">Terms of Service</h1>
      <p className="marketing-lede">
        These terms govern your use of the <strong>hosted</strong> Odyhook
        service at <code>odyhook.dev</code>. The Odyhook software itself is open
        source; if you <Link href="/docs/quickstart">self-host</Link>, your use
        is governed by the software licence in the repository, not these terms.
      </p>
      <p>
        <em>Last updated: {UPDATED}.</em> By creating an account or sending
        traffic to the service you agree to these terms. If you do not agree, do
        not use the hosted service.
      </p>

      <h2>1. The service</h2>
      <p>
        Odyhook receives webhooks, stores them, and forwards them to destinations
        you configure, with retries. It is operated by an individual sole
        operator in the EU on a best-effort basis. It is provided free of charge.
      </p>

      <h2>2. Acceptable use</h2>
      <p>You agree not to use the service to:</p>
      <ul>
        <li>
          send unlawful, infringing, or malicious content, or relay spam,
          malware, or phishing;
        </li>
        <li>
          probe, scan, or use our ingest endpoints as infrastructure to attack
          or reach third-party systems you are not authorised to reach
          (including as an SSRF or proxy relay);
        </li>
        <li>
          route data you have no lawful basis to process, including special
          categories of personal data you are not entitled to share;
        </li>
        <li>
          disrupt, overload, or attempt to circumvent the rate limits, quotas, or
          security of the service or its other users.
        </li>
      </ul>
      <p>
        You are responsible for the content of every webhook you route and for
        having the right to process and forward it.
      </p>

      <h2>3. No warranty</h2>
      <p>
        <strong>
          The service is provided &ldquo;as is&rdquo; and &ldquo;as
          available&rdquo;, without warranties of any kind, express or implied
        </strong>{" "}
        &mdash; including merchantability, fitness for a particular purpose, and
        non-infringement. We do not warrant that the service will be
        uninterrupted, timely, secure, or error-free, or that any event will be
        received, stored, delivered, or retried. The service runs on a single
        server with no high-availability guarantee; during an outage, inbound
        webhooks may be rejected and lost before we ever store them. For
        load-bearing production traffic we recommend{" "}
        <Link href="/docs/quickstart">self-hosting</Link>.
      </p>

      <h2>4. Limitation of liability</h2>
      <p>
        To the maximum extent permitted by law, the operator will not be liable
        for any indirect, incidental, special, consequential, or punitive
        damages, or for any loss of profits, revenue, data, or goodwill, arising
        from or related to your use of (or inability to use) the service. Because
        the service is provided free of charge, the operator&rsquo;s total
        aggregate liability to you for all claims is limited to{" "}
        <strong>EUR&nbsp;100</strong>. Nothing in these terms excludes liability
        that cannot lawfully be excluded.
      </p>

      <h2>5. Privacy and data processing</h2>
      <p>
        Our handling of your data is described in the{" "}
        <Link href="/privacy">Privacy Policy</Link> and our use of
        infrastructure providers in the{" "}
        <Link href="/subprocessors">sub-processor list</Link>. Where you route
        personal data belonging to your own users, you are the controller and we
        act as your processor; a DPA is available on request.
      </p>

      <h2>6. Termination</h2>
      <p>
        You may stop using the service and delete your account at any time from{" "}
        <Link href="/settings/account">Settings → Account</Link>. We may suspend
        or terminate any account that violates these terms, that we reasonably
        believe poses a security or legal risk, or where required to protect the
        service or other users &mdash; with notice where practicable. We may also
        discontinue the hosted service entirely; we will give reasonable notice so
        you can export your data.
      </p>

      <h2>7. Changes</h2>
      <p>
        We may update these terms as the service evolves. The &ldquo;last
        updated&rdquo; date above reflects the current version; continued use
        after a change constitutes acceptance.
      </p>

      <h2>8. Governing law</h2>
      <p>
        These terms are governed by the laws of <strong>Finland</strong>, and any
        dispute is subject to the exclusive jurisdiction of the Finnish courts,
        without prejudice to any mandatory consumer-protection rights you have in
        your country of residence.
      </p>

      <p style={{ marginTop: "2.5rem", fontSize: "0.9rem" }}>
        <Link href="/privacy">Privacy Policy</Link> ·{" "}
        <Link href="/subprocessors">Sub-processors</Link> ·{" "}
        <Link href="/security">Security</Link>
      </p>
    </div>
  );
}
