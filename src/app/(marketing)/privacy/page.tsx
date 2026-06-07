import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy Policy — Odyhook",
  description:
    "What data the hosted Odyhook service collects, why, where it is stored, who it is shared with, and your rights under GDPR.",
};

// Last updated — bump whenever the substance below changes.
const UPDATED = "7 June 2026";

export default function PrivacyPage() {
  return (
    <div className="docs-prose">
      <h1 className="marketing-h1">Privacy Policy</h1>
      <p className="marketing-lede">
        This policy covers the <strong>hosted</strong> Odyhook service at{" "}
        <code>odyhook.dev</code> (&ldquo;Path&nbsp;2&rdquo;). If you{" "}
        <Link href="/docs/quickstart">self-host Odyhook</Link> (&ldquo;Path&nbsp;1&rdquo;),
        your webhook data never touches our infrastructure and this policy does
        not apply &mdash; you are your own data controller.
      </p>
      <p>
        <em>Last updated: {UPDATED}.</em>
      </p>

      <h2>Who we are</h2>
      <p>
        The hosted Odyhook instance is operated by an individual sole operator
        based in the EU. For any privacy question, data-access request, or
        deletion request, contact{" "}
        <a href="mailto:ngkdev93@gmail.com">ngkdev93@gmail.com</a>. Security
        vulnerabilities should instead be reported via our{" "}
        <Link href="/security">security policy</Link>.
      </p>

      <h2>What data we collect, and why</h2>
      <table>
        <thead>
          <tr>
            <th>Category</th>
            <th>What</th>
            <th>Why</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Account</td>
            <td>
              Your email address; if you sign in with GitHub, the name and avatar
              URL GitHub returns.
            </td>
            <td>To authenticate you and send magic-link / operational email.</td>
          </tr>
          <tr>
            <td>Webhook payloads</td>
            <td>
              The full body, headers, source IP, and timestamp of every webhook
              you route through us, stored raw.
            </td>
            <td>
              To deliver, retry, replay, and let you inspect events &mdash; the
              core function of the product.
            </td>
          </tr>
          <tr>
            <td>Delivery metadata</td>
            <td>
              Destination URLs, response codes, error messages, attempt counts.
            </td>
            <td>To run retries, the circuit breaker, and your dashboards.</td>
          </tr>
          <tr>
            <td>Secrets (encrypted)</td>
            <td>
              Source signing secrets, destination headers, and your
              bring-your-own Anthropic API key.
            </td>
            <td>
              To verify inbound signatures, authenticate to your destinations,
              and run AI features as you. Encrypted at rest with AES-256-GCM.
            </td>
          </tr>
        </tbody>
      </table>
      <p>
        <strong>Personal data in payloads.</strong> Webhook payloads frequently
        contain personal data belonging to <em>your</em> customers (emails,
        names, IDs). For that data you are the controller and we are your
        processor; you are responsible for having a lawful basis to send it to
        us. See <Link href="/terms">our Terms</Link> and the DPA note below.
      </p>

      <h2>How long we keep it</h2>
      <p>
        Account data is kept while your account exists. Webhook events and their
        deliveries are kept for a <strong>retention window you configure per
        source</strong> (default 90 days, maximum 365); a daily purge job
        permanently deletes events older than that window. You can shorten the
        window or delete individual sources at any time. Deleting your account
        removes all of the above (see &ldquo;Your rights&rdquo;).
      </p>

      <h2>Who we share it with (sub-processors)</h2>
      <p>
        Running the service requires a small number of infrastructure providers.
        Your data may pass through or be stored by each of them for the purpose
        listed. The current list lives on a dedicated, versioned page:
      </p>
      <p>
        <Link href="/subprocessors">→ Odyhook sub-processors</Link>
      </p>
      <p>
        We do not sell your data, and we do not use it for advertising. A Data
        Processing Agreement (DPA) is available on request for business users
        &mdash; email the address above.
      </p>

      <h2>Cookies</h2>
      <p>
        We use only <strong>strictly-necessary</strong> session cookies (the
        sign-in session token, a CSRF token, and a callback URL during login).
        We run <strong>no analytics, advertising, or tracking</strong> SDKs, so
        no consent banner is required. A dark-mode preference is stored in your
        browser&rsquo;s <code>localStorage</code>, never sent to us.
      </p>

      <h2>Your rights</h2>
      <p>
        Under the GDPR you have the right to access, export, correct, and erase
        your personal data. We support these directly:
      </p>
      <ul>
        <li>
          <strong>Export</strong> &mdash; download a JSON copy of your account,
          sources, events, and deliveries from{" "}
          <Link href="/settings/account">Settings → Account</Link>.
        </li>
        <li>
          <strong>Erasure</strong> &mdash; delete your account (and all
          associated data, by database cascade) from the same page.
        </li>
        <li>
          Any other request (correction, restriction, complaint) &mdash; email{" "}
          <a href="mailto:ngkdev93@gmail.com">ngkdev93@gmail.com</a>. You may also
          complain to your local data-protection authority.
        </li>
      </ul>

      <h2>Where data is stored</h2>
      <p>
        Primary storage is a server in Helsinki, Finland (EU). Off-site backups
        and error traces are processed by the sub-processors listed above, some
        of which operate globally; see that page for each provider&rsquo;s role.
      </p>

      <h2>Changes</h2>
      <p>
        We may update this policy as the service evolves. The &ldquo;last
        updated&rdquo; date above always reflects the current version.
      </p>

      <p style={{ marginTop: "2.5rem", fontSize: "0.9rem" }}>
        <Link href="/terms">Terms of Service</Link> ·{" "}
        <Link href="/subprocessors">Sub-processors</Link> ·{" "}
        <Link href="/security">Security</Link>
      </p>
    </div>
  );
}
