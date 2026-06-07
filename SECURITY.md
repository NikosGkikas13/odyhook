# Security Policy

Odyhook is open source and operated, on its hosted instance (`odyhook.dev`), by
a single individual. We take security reports seriously and appreciate
responsible disclosure.

## Reporting a vulnerability

Please report security issues **privately** — do not open a public GitHub issue
for a vulnerability.

Preferred channel:

- **GitHub private vulnerability reporting:**
  <https://github.com/NikosGkikas13/odyhook/security/advisories/new>

Alternative:

- **Email:** ngkdev93@gmail.com (you may PGP-encrypt; ask for a key if needed)

Please include enough detail to reproduce: affected endpoint or file, steps,
and impact. If you have a proof-of-concept, include it.

## What to expect

- **Acknowledgement:** best-effort within 5 days. This is a solo-operated
  project, so response times are not guaranteed.
- **Triage:** we'll confirm the issue, assess severity, and agree a disclosure
  timeline with you.
- **Fix & credit:** once fixed, we're happy to credit you (with your consent).

## Scope

In scope:

- The hosted service at `odyhook.dev` (the web app, ingest endpoints, REST API,
  and worker behaviour).
- The Odyhook source code in this repository.

Out of scope:

- Denial-of-service / volumetric testing against the hosted instance.
- Social engineering, physical attacks, or attacks on third-party
  sub-processors (see <https://odyhook.dev/subprocessors>).
- Reports from automated scanners with no demonstrated impact.

## Security posture

A few things worth knowing about how Odyhook is built:

- Secrets (source signing secrets, destination headers, BYOK Anthropic keys)
  are encrypted at rest with AES-256-GCM.
- Outbound delivery uses SSRF protection (scheme/IP checks, resolve-and-pin,
  manual redirect handling) so destinations can't be used to reach internal
  hosts.
- HMAC signature verification is constant-time; inbound bodies are size-capped.
- Sentry error traces are scrubbed of request bodies, cookies, query strings,
  and sensitive headers before sending.

For the strongest isolation, you can also
[self-host Odyhook](https://odyhook.dev/docs/quickstart) — then your webhook
data never touches our infrastructure at all.
